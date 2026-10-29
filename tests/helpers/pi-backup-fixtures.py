"""Synthetic systemd lifecycle only. Never invokes systemctl or production paths."""
import copy
import datetime
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch, mock_open
import stat

source = Path(__file__).resolve().parents[2] / "scripts/pi-backup-coordinator.py"
spec = importlib.util.spec_from_file_location("backup_coordinator", source)
coordinator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(coordinator)
# Only synthetic identities for pure operation tests; production has no defaults.
coordinator.APP = "/srv/spesesmart/app"
coordinator.NODE = "/synthetic/node"
coordinator.SSD_MOUNT = "/srv/spesesmart"
coordinator.SSD_UUID = "11111111-2222-4333-8444-555555555555"
coordinator.USB_UUID = "22222222-3333-4444-8555-666666666666"
coordinator.USB_MOUNT = "/mnt/spesesmart-backup"
coordinator.USB_DEVICE = "/dev/disk/by-uuid/" + coordinator.USB_UUID
coordinator.BACKUP_LABEL = "SPESESMART_BKP"
coordinator.USER = "spesesmart"
coordinator.HOME = "/home/spesesmart"


MONDAY = datetime.datetime(2026, 10, 19, 1, 15, tzinfo=datetime.timezone.utc)
SUNDAY = datetime.datetime(2026, 10, 25, 2, 15, tzinfo=datetime.timezone.utc)
IDENT = "66318f48-4332-4af6-a499-fc9dcce209c5"


class SyntheticOperations:
    def __init__(self, running=True):
        self.events = []
        self.state = {"fingerprint": "a" * 64, "configurationFingerprint": "c" * 64,
                      "pending": 0, "unknownAI": 0, "installationId": "fixture-installation"}
        self.unit = {"ActiveState": "active" if running else "inactive", "SubState": "running" if running else "dead",
                     "MainPID": "123" if running else "0", "Result": "success"}
        self.fail_at = {}
        self.hooks = {}
        self.preserved = b"latest ledger, journal, historical weekly and current credentials"
        self.usb_state = "RO"
        self.archives = {"old-weekly": "b" * 64}

    def event(self, name):
        self.events.append(name)
        if name in self.hooks:
            self.hooks[name](self)
        if name in self.fail_at:
            raise coordinator.Failure(self.fail_at[name])

    def preflight(self):
        self.event("preflight")
        return copy.deepcopy(self.state)

    def preflight_readonly(self):
        self.event("preflight-readonly")
        return copy.deepcopy(self.state)

    def history(self):
        self.event("history")
        if self.usb_state == "UNMOUNTED":
            raise coordinator.Failure("USB_MOUNT")
        return {"repositorySHA256": "e" * 64, "sets": self.archives.copy(), "partial": []}

    def open_usb(self):
        self.event("open-usb")
        self.usb_state = "RW"

    def close_usb(self):
        self.event("close-usb")
        self.usb_state = "RO"
        return {"state": "RO", "commandFailed": False}

    def usb_closed(self):
        self.event("usb-closed")
        if self.usb_state not in {"RO", "UNMOUNTED"}:
            raise coordinator.Failure("USB_CLEANUP")
        return self.usb_state

    def service(self):
        return copy.deepcopy(self.unit)

    def stop(self):
        self.event("drain")
        self.unit.update(ActiveState="inactive", SubState="dead", MainPID="0")

    def quiescent(self):
        self.event("quiescent")
        if self.state["pending"] or self.state["unknownAI"]:
            raise coordinator.Failure("RECOVERY_REQUIRED")
        return copy.deepcopy(self.state)

    def daily(self):
        self.event("daily")
        self.archives[IDENT] = "d" * 64
        return {"status": "verified", "kind": "daily", "id": IDENT}

    def verify(self, ident):
        self.event("verify")
        assert ident == IDENT
        return {"fingerprint": "a" * 64, "installationId": self.state["installationId"],
                "manifestSHA256": "d" * 64, "createdAt": MONDAY.isoformat()}

    def restore(self, ident):
        self.event("restore")
        assert ident == IDENT
        return {"status": "isolated-verified", "remoteRestore": False}

    def start(self):
        self.event("start")
        self.unit.update(ActiveState="active", SubState="running", MainPID="456")

    def running(self):
        self.event("ready")


class MaintenanceTests(unittest.TestCase):
    def test_root_configuration_identity_and_protected_file(self):
        config = {"mount": "/srv/spesesmart", "ssdUUID": coordinator.SSD_UUID,
                  "node": "/opt/node24/bin/node", "home": "/home/spesesmart", "user": "spesesmart",
                  "tlsDirectory": "/srv/spesesmart/tls/current", "ip": "192.168.1.50",
                  "backupMount": "/mnt/spesesmart-backup", "backupUUID": coordinator.USB_UUID,
                  "backupLabel": "SPESESMART_BKP"}
        names = ["APP", "NODE", "USB_UUID", "SSD_UUID", "USB_MOUNT", "USB_DEVICE", "SSD_MOUNT", "USER", "HOME", "BACKUP_LABEL"]
        snapshot = {name: getattr(coordinator, name) for name in names}
        def info(path):
            return SimpleNamespace(st_uid=0, st_mode=(stat.S_IFREG | 0o644) if str(path) == coordinator.CONFIG_PATH else (stat.S_IFDIR | 0o755))
        try:
            with patch.object(Path, "lstat", info), patch("pwd.getpwnam", return_value=SimpleNamespace(pw_uid=1001, pw_dir=config["home"])):
                with patch("builtins.open", mock_open(read_data=json.dumps(config))):
                    coordinator.load_installation()
                    self.assertEqual(coordinator.NODE, config["node"])
                    self.assertEqual(coordinator.USB_DEVICE, "/dev/disk/by-uuid/" + config["backupUUID"])
                for change in [{"ssdUUID": "wrong"}, {"backupUUID": config["ssdUUID"]}, {"backupMount": config["mount"]}, {"backupMount": "/tmp/a/../b"}, {"home": "/another-home"}, {"backupLabel": "bad label"}]:
                    with self.subTest(change=change), patch("builtins.open", mock_open(read_data=json.dumps({**config, **change}))):
                        with self.assertRaises(coordinator.Failure): coordinator.load_installation()
            for mode, uid in [(stat.S_IFREG | 0o666, 0), (stat.S_IFLNK | 0o644, 0), (stat.S_IFREG | 0o644, 1001)]:
                with patch.object(Path, "lstat", return_value=SimpleNamespace(st_uid=uid, st_mode=mode)):
                    with self.assertRaises(coordinator.Failure): coordinator.load_installation()
        finally:
            for name, value in snapshot.items(): setattr(coordinator, name, value)

    def execute(self, ops=None, now=MONDAY, first_trial=False):
        ops = ops or SyntheticOperations()
        preserved = ops.preserved
        report = coordinator.run_job(ops, now, first_trial=first_trial)
        self.assertEqual(ops.preserved, preserved)
        self.assertNotIn("weekly", ops.events)
        if "start" in ops.events:
            self.assertLess(ops.events.index("close-usb"), ops.events.index("start"))
            self.assertIn(report["usbClosure"], {"RO", "UNMOUNTED"})
        return ops, report

    def test_daily_stops_drains_verifies_and_restarts_once(self):
        ops, result = self.execute()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(ops.events, ["preflight-readonly", "history", "open-usb", "preflight", "drain", "quiescent", "preflight", "daily", "verify", "quiescent", "history", "close-usb", "usb-closed", "quiescent", "usb-closed", "start", "ready"])
        self.assertEqual(result["usbClosure"], "RO")

    def test_sunday_restore_is_of_the_new_technical_set(self):
        ops, result = self.execute(now=SUNDAY)
        self.assertEqual(result["restoreTest"], "PASS")
        self.assertEqual(ops.events.count("restore"), 1)

    def test_periodic_restore_uses_rome_day_not_utc(self):
        saturday_utc = datetime.datetime(2026, 10, 24, 22, 30, tzinfo=datetime.timezone.utc)
        ops, _ = self.execute(now=saturday_utc)
        self.assertIn("restore", ops.events)

    def test_initially_stopped_service_stays_stopped(self):
        ops, result = self.execute(SyntheticOperations(False), SUNDAY)
        self.assertEqual(result["status"], "PASS")
        self.assertNotIn("drain", ops.events)
        self.assertNotIn("start", ops.events)

    def test_missing_readonly_or_wrong_usb_never_stops_production(self):
        for code in ["BACKUP_UUID", "BACKUP_MOUNT", "SPACE", "PARTIAL_PRESENT", "PERMISSIONS"]:
            with self.subTest(code=code):
                ops = SyntheticOperations(); ops.fail_at["preflight-readonly"] = code
                _, result = self.execute(ops)
                self.assertEqual(result["status"], "BLOCK")
                self.assertEqual(ops.events, ["preflight-readonly"])
                self.assertTrue(coordinator.is_running(ops.unit))

    def test_recovery_blocks_before_stop(self):
        ops = SyntheticOperations(); ops.fail_at["preflight-readonly"] = "RECOVERY_REQUIRED"
        ops, result = self.execute(ops)
        self.assertNotIn("drain", ops.events)
        self.assertEqual(result["code"], "RECOVERY_REQUIRED")

    def test_failed_or_transitioning_unit_is_untouched(self):
        for state in ["failed", "activating", "deactivating"]:
            ops = SyntheticOperations(); ops.unit["ActiveState"] = state
            ops, result = self.execute(ops)
            self.assertEqual(result["code"], "SERVICE_STATE")
            self.assertEqual(ops.events, ["preflight-readonly"])

    def test_failed_drain_never_backs_up_or_restarts(self):
        ops = SyntheticOperations(); ops.fail_at["drain"] = "COMMAND_TIMEOUT"
        ops, result = self.execute(ops)
        self.assertNotIn("daily", ops.events); self.assertNotIn("start", ops.events)
        self.assertTrue(result["manualCheckRequired"])

    def test_non_successful_stop_result_is_not_clean(self):
        ops = SyntheticOperations(); ops.hooks["drain"] = lambda o: o.unit.update(Result="timeout")
        ops, result = self.execute(ops)
        self.assertEqual(result["code"], "STOP_UNSAFE")
        self.assertNotIn("start", ops.events)

    def test_surviving_backend_lock_or_listener_blocks_before_copy(self):
        ops = SyntheticOperations(); ops.fail_at["quiescent"] = "BUSY"
        ops, _ = self.execute(ops)
        self.assertNotIn("daily", ops.events); self.assertNotIn("start", ops.events)

    def test_configuration_change_during_drain_needs_manual_review(self):
        ops = SyntheticOperations()
        ops.hooks["drain"] = lambda o: o.state.update(configurationFingerprint="different")
        ops, result = self.execute(ops)
        self.assertEqual(result["code"], "CONFIGURATION_CHANGED")
        self.assertNotIn("daily", ops.events); self.assertNotIn("start", ops.events)

    def test_completed_inflight_operation_is_frozen_after_drain(self):
        ops = SyntheticOperations()
        ops.state["fingerprint"] = "before-drain"
        ops.hooks["drain"] = lambda o: o.state.update(fingerprint="a" * 64)
        _, result = self.execute(ops)
        self.assertEqual(result["status"], "PASS")
        self.assertTrue(result["drainChangedTechnicalState"])

    def test_backup_failure_restarts_only_unchanged_healthy_source(self):
        ops = SyntheticOperations(); ops.fail_at["daily"] = "SPACE"
        ops, result = self.execute(ops)
        self.assertEqual(result["status"], "BLOCK")
        self.assertTrue(result["serviceRestarted"])
        self.assertEqual(ops.events.count("daily"), 1)
        self.assertEqual(ops.events.count("start"), 1)

    def test_checksum_failure_is_still_failure_after_safe_restart(self):
        ops = SyntheticOperations(); ops.fail_at["verify"] = "CHECKSUM"
        ops, result = self.execute(ops)
        self.assertEqual(result["code"], "CHECKSUM")
        self.assertTrue(result["serviceRestarted"])

    def test_restore_failure_preserves_set_and_never_retries_restore(self):
        ops = SyntheticOperations(); ops.fail_at["restore"] = "CHECKSUM"
        ops, result = self.execute(ops, SUNDAY)
        self.assertEqual(result["status"], "BLOCK")
        self.assertTrue(result["serviceRestarted"])
        self.assertEqual(result["backupId"], IDENT)
        self.assertEqual(ops.events.count("restore"), 1)

    def test_source_change_prevents_automatic_restart(self):
        ops = SyntheticOperations(); ops.hooks["daily"] = lambda o: o.state.update(fingerprint="newer")
        ops, result = self.execute(ops)
        self.assertEqual(result["status"], "BLOCK")
        self.assertNotIn("start", ops.events)

    def test_new_unknown_after_copy_is_not_zeroed_or_restarted(self):
        ops = SyntheticOperations(); ops.hooks["daily"] = lambda o: o.state.update(unknownAI=1)
        ops, result = self.execute(ops)
        self.assertEqual(ops.state["unknownAI"], 1)
        self.assertNotIn("start", ops.events)
        self.assertTrue(result["manualCheckRequired"])

    def test_wrong_set_type_is_rejected(self):
        ops = SyntheticOperations()
        ops.daily = lambda: {"status": "verified", "kind": "weekly", "id": IDENT}
        ops, result = self.execute(ops)
        self.assertEqual(result["code"], "DAILY_RESULT")
        self.assertNotIn("verify", ops.events)

    def test_no_retry_or_rollback_after_failed_start(self):
        ops = SyntheticOperations(); ops.fail_at["start"] = "START_UNSAFE"
        ops, result = self.execute(ops)
        self.assertEqual(ops.events.count("start"), 1)
        self.assertTrue(result["manualCheckRequired"])

    def test_failed_readiness_does_not_stop_a_new_running_server(self):
        ops = SyntheticOperations(); ops.fail_at["ready"] = "LISTENERS"
        ops, result = self.execute(ops)
        self.assertTrue(coordinator.is_running(ops.unit))
        self.assertEqual(ops.events.count("drain"), 1)
        self.assertEqual(result["status"], "BLOCK")

    def test_errors_do_not_print_secrets_or_exception_payloads(self):
        ops = SyntheticOperations()
        def unsafe():
            raise RuntimeError("password=secret; contents of private ledger")
        ops.daily = unsafe
        _, result = self.execute(ops)
        self.assertNotIn("secret", json.dumps(result))
        self.assertEqual(result["code"], "VALIDATION")

    def test_coordinator_lock_serializes_jobs_without_touching_writer_lock(self):
        with tempfile.TemporaryDirectory(prefix="spesesmart-backup-lock-fixture-") as directory:
            path = str(Path(directory) / "job.lock")
            with coordinator.coordinator_lock(path):
                with self.assertRaises(coordinator.Failure):
                    with coordinator.coordinator_lock(path):
                        self.fail("Second job acquired lock")
            with coordinator.coordinator_lock(path):
                self.assertEqual(Path(path).read_bytes(), b"")

    def test_coordinator_lock_rejects_symlink_and_public_permissions(self):
        with tempfile.TemporaryDirectory(prefix="spesesmart-backup-lock-fixture-") as directory:
            path = Path(directory) / "lock"; path.write_bytes(b"preserve")
            os.chmod(path, 0o644)
            with self.assertRaises(coordinator.Failure):
                with coordinator.coordinator_lock(str(path)):
                    pass
            link = Path(directory) / "link"; link.symlink_to(path)
            with self.assertRaises(OSError):
                with coordinator.coordinator_lock(str(link)):
                    pass
            self.assertEqual(path.read_bytes(), b"preserve")

    def test_production_adapter_only_selects_official_daily_and_unprivileged_user(self):
        ops = coordinator.ProductionOperations(); captured = []
        ops.command = lambda args, timeout=30: (captured.append(args) or '{"status":"verified"}')
        ops.daily()
        args = captured[0]
        self.assertEqual(args[-2:], ["scripts/backup.mts", "daily"])
        self.assertEqual(args[:4], ["/usr/sbin/runuser", "--user", "spesesmart", "--"])
        self.assertIn("-i", args)
        self.assertNotIn("weekly", args)
        with self.assertRaises(coordinator.Failure):
            ops.worker("weekly")
        with self.assertRaises(coordinator.Failure):
            ops.worker("restore", "../../other")

    def test_first_trial_forces_restore_without_faking_weekday(self):
        ops, result = self.execute(first_trial=True)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["at"], MONDAY.isoformat())
        self.assertEqual(result["restoreTest"], "PASS")
        self.assertLess(ops.events.index("restore"), ops.events.index("close-usb"))
        self.assertLess(ops.events.index("close-usb"), ops.events.index("start"))

    def test_first_trial_restore_failure_closes_usb_before_conditional_start(self):
        ops = SyntheticOperations(); ops.fail_at["restore"] = "CHECKSUM"
        ops, result = self.execute(ops, first_trial=True)
        self.assertEqual(result["status"], "BLOCK")
        self.assertEqual(result["restoreTest"], "BLOCK")
        self.assertTrue(result["serviceRestarted"])
        self.assertLess(ops.events.index("close-usb"), ops.events.index("start"))

    def test_cleanup_failure_never_restarts_stopped_app(self):
        for failure in [None, "SPACE", "CHECKSUM"]:
            ops = SyntheticOperations(); ops.fail_at["close-usb"] = "USB_CLEANUP"
            if failure:
                ops.fail_at["daily" if failure == "SPACE" else "verify"] = failure
            ops, result = self.execute(ops)
            self.assertEqual(result["status"], "BLOCK")
            self.assertEqual(ops.usb_state, "RW")
            self.assertNotIn("start", ops.events)
            self.assertTrue(result["manualCheckRequired"])

    def test_cleanup_observation_failure_is_not_assumed_safe(self):
        ops = SyntheticOperations(); ops.fail_at["usb-closed"] = "USB_OBSERVATION"
        ops, result = self.execute(ops)
        self.assertNotIn("start", ops.events)
        self.assertEqual(result["usbClosure"], "NOT VERIFIED")

    def test_rw_reappearance_immediately_before_start_blocks(self):
        ops = SyntheticOperations()
        ops.hooks["quiescent"] = lambda o: setattr(o, "usb_state", "RW")
        ops, result = self.execute(ops)
        self.assertNotIn("start", ops.events)
        self.assertEqual(result["status"], "BLOCK")

    def test_failed_open_that_left_rw_is_finalized_without_stopping_app(self):
        ops = SyntheticOperations()
        ops.hooks["open-usb"] = lambda o: setattr(o, "usb_state", "RW")
        ops.fail_at["open-usb"] = "COMMAND_FAILED"
        ops, result = self.execute(ops)
        self.assertEqual(ops.usb_state, "RO")
        self.assertNotIn("drain", ops.events)
        self.assertNotIn("start", ops.events)
        self.assertEqual(result["status"], "BLOCK")

    def test_failed_open_and_cleanup_leave_running_app_untouched(self):
        ops = SyntheticOperations()
        ops.hooks["open-usb"] = lambda o: setattr(o, "usb_state", "RW")
        ops.fail_at.update({"open-usb": "COMMAND_FAILED", "close-usb": "USB_CLEANUP"})
        ops, result = self.execute(ops)
        self.assertTrue(coordinator.is_running(ops.unit))
        self.assertEqual(ops.usb_state, "RW")
        self.assertNotIn("drain", ops.events)
        self.assertEqual(result["usbClosure"], "NOT VERIFIED")

    def test_historical_change_blocks_restart_and_never_restores_old_data(self):
        ops = SyntheticOperations()
        ops.hooks["daily"] = lambda o: o.archives.update({"old-weekly": "changed"})
        ops, result = self.execute(ops)
        self.assertEqual(result["historyPreserved"], "NOT VERIFIED")
        self.assertNotIn("start", ops.events)
        self.assertEqual(ops.usb_state, "RO")

    def test_readonly_fallback_after_command_error_still_reports_block(self):
        ops = SyntheticOperations()
        def close():
            ops.event("close-usb"); ops.usb_state = "UNMOUNTED"
            return {"state": "UNMOUNTED", "commandFailed": True}
        ops.close_usb = close
        ops, result = self.execute(ops)
        self.assertEqual(result["status"], "BLOCK")
        self.assertEqual(result["usbClosure"], "UNMOUNTED")
        self.assertTrue(result["serviceRestarted"])

    def test_closed_usb_is_required_even_if_app_was_initially_off(self):
        ops = SyntheticOperations(False); ops.fail_at["close-usb"] = "USB_CLEANUP"
        ops, result = self.execute(ops, first_trial=True)
        self.assertEqual(result["status"], "BLOCK")
        self.assertNotIn("start", ops.events)


class MountCommands:
    """All commands simulated; the production mount algorithm runs unchanged."""
    def __init__(self):
        self.row = {"target": coordinator.USB_MOUNT, "uuid": coordinator.USB_UUID,
                    "label": "SPESESMART_BKP", "fstype": "ext4", "maj:min": "8:99",
                    "options": "ro,nosuid,nodev,noexec,norecovery"}
        self.ssd = {"target": "/srv/spesesmart", "uuid": coordinator.SSD_UUID, "fstype": "ext4", "options": "rw"}
        self.extra = []; self.events = []; self.fail_before = set(); self.fail_after = set()
        self.clean = True

    def command(self, args):
        if args[0] == "/usr/bin/findmnt":
            return json.dumps({"filesystems": [self.ssd, *([self.row] if self.row else []), *self.extra]})
        if args[0] == "/usr/sbin/dumpe2fs":
            self.events.append("superblock")
            return "Filesystem state: clean\nFilesystem features: extents\n" if self.clean else "Filesystem state: not clean\nFilesystem features: needs_recovery\n"
        event = "unmount" if args[0] == "/usr/bin/umount" else "mount-rw" if "rw,nosuid,nodev,noexec" in args else "mount-ro"
        self.events.append(event)
        if event in self.fail_before:
            raise coordinator.Failure("COMMAND_FAILED")
        if event == "unmount":
            assert args == ["/usr/bin/umount", "--", coordinator.USB_MOUNT]
            self.template = self.row.copy(); self.row = None
        else:
            expected = "rw,nosuid,nodev,noexec" if event == "mount-rw" else "ro,noload,nosuid,nodev,noexec"
            assert args == ["/usr/bin/mount", "-t", "ext4", "-o", expected, "--", coordinator.USB_DEVICE, coordinator.USB_MOUNT]
            self.row = {**self.template, "options": expected}
        if event in self.fail_after:
            raise coordinator.Failure("COMMAND_FAILED")
        return ""


class FixtureUSB(coordinator.BackupUSB):
    def device(self):
        return "8:99"

    def empty_mountpoint(self):
        pass  # Synthetic mountpoint only; no filesystem path is inspected.


class MountSafetyTests(unittest.TestCase):
    def test_surviving_command_cannot_race_mount_cleanup_or_start(self):
        ops = coordinator.ProductionOperations()
        pending = SimpleNamespace(poll=lambda: None)
        ops.unresolved_commands = [pending]
        ops.command = lambda *_args, **_kwargs: self.fail("No command may run while a previous command survives")
        for action in [ops.open_usb, ops.close_usb, ops.usb_closed, ops.quiescent, ops.start]:
            with self.assertRaises(coordinator.Failure) as raised:
                action()
            self.assertEqual(raised.exception.code, "COMMAND_IN_FLIGHT")
        pending.poll = lambda: 0
        ops.no_unresolved_commands()
        self.assertEqual(ops.unresolved_commands, [])

    def test_root_guard_rejects_private_mount_namespace_even_for_first_trial(self):
        def metadata(path):
            mode = stat.S_IFREG if str(path) == coordinator.INSTALLED else stat.S_IFDIR
            return SimpleNamespace(st_mode=mode | 0o755, st_uid=0)
        def namespace(path):
            return SimpleNamespace(st_ino=1 if path == "/proc/1/ns/mnt" else 2)
        with (patch.object(coordinator, "__file__", coordinator.INSTALLED),
              patch.object(coordinator.sys, "argv", [coordinator.INSTALLED, "--first-trial"]),
              patch.object(coordinator.os, "getuid", return_value=0),
              patch.object(coordinator.os, "uname", return_value=SimpleNamespace(machine="aarch64", nodename="spesesmart-pi")),
              patch.object(coordinator.os, "stat", side_effect=namespace),
              patch.object(Path, "lstat", autospec=True, side_effect=metadata)):
            with self.assertRaises(coordinator.Failure) as raised:
                coordinator.installed_guard()
            self.assertEqual(raised.exception.code, "HOST_MOUNT_NAMESPACE")

    def setup_usb(self):
        ops = MountCommands()
        return ops, FixtureUSB(ops)

    def test_fresh_rw_session_then_clean_readonly_mount(self):
        ops, usb = self.setup_usb(); usb.open(); self.assertEqual(usb.observe()["state"], "RW")
        self.assertEqual(usb.close(), {"state": "RO", "commandFailed": False})
        self.assertEqual(ops.events, ["unmount", "superblock", "mount-rw", "unmount", "superblock", "mount-ro"])

    def test_mount_rw_exit_failure_does_not_hide_actual_rw(self):
        ops, usb = self.setup_usb(); ops.fail_after.add("mount-rw")
        with self.assertRaises(coordinator.Failure): usb.open()
        self.assertEqual(usb.observe()["state"], "RW")
        self.assertEqual(usb.close()["state"], "RO")

    def test_unmount_exit_failure_is_checked_against_actual_mount(self):
        ops, usb = self.setup_usb(); usb.open(); ops.fail_after.add("unmount")
        result = usb.close()
        self.assertEqual(result["state"], "RO"); self.assertTrue(result["commandFailed"])

    def test_busy_unmount_preserves_rw_and_blocks(self):
        ops, usb = self.setup_usb(); usb.open(); ops.fail_before.add("unmount")
        with self.assertRaises(coordinator.Failure): usb.close()
        self.assertEqual(usb.observe()["state"], "RW")
        self.assertNotIn("mount-ro", ops.events)

    def test_failed_ro_mount_accepts_only_verified_unmounted_fallback(self):
        ops, usb = self.setup_usb(); usb.open(); ops.fail_before.add("mount-ro")
        self.assertEqual(usb.close(), {"state": "UNMOUNTED", "commandFailed": True})
        self.assertEqual(usb.closed(), "UNMOUNTED")

    def test_ro_mount_error_after_success_reports_error_and_observed_ro(self):
        ops, usb = self.setup_usb(); usb.open(); ops.fail_after.add("mount-ro")
        self.assertEqual(usb.close(), {"state": "RO", "commandFailed": True})

    def test_dirty_ext4_is_not_mounted_replayed_or_repaired(self):
        ops, usb = self.setup_usb(); ops.clean = False
        with self.assertRaises(coordinator.Failure): usb.open()
        self.assertNotIn("mount-rw", ops.events)
        self.assertEqual(usb.closed(), "UNMOUNTED")

    def test_dirty_ext4_on_close_stays_unmounted(self):
        ops, usb = self.setup_usb(); usb.open(); ops.clean = False
        self.assertEqual(usb.close(), {"state": "UNMOUNTED", "commandFailed": True})
        self.assertNotIn("mount-ro", ops.events)

    def test_foreign_uuid_label_or_device_never_gets_unmounted(self):
        for field, value in [("uuid", "foreign"), ("label", "other"), ("maj:min", "8:77"), ("fstype", "xfs")]:
            ops, usb = self.setup_usb(); ops.row[field] = value
            with self.assertRaises(coordinator.Failure): usb.open()
            with self.assertRaises(coordinator.Failure): usb.close()
            self.assertEqual(ops.events, [])

    def test_additional_mount_or_nested_mount_blocks(self):
        for extra in [{"target": "/another", "maj:min": "8:99"}, {"target": coordinator.USB_MOUNT + "/nested"}]:
            ops, usb = self.setup_usb(); ops.extra.append(extra)
            with self.assertRaises(coordinator.Failure): usb.open()
            self.assertEqual(ops.events, [])

    def test_wrong_ssd_blocks_before_usb_unmount(self):
        ops, usb = self.setup_usb(); ops.ssd["uuid"] = "wrong"
        with self.assertRaises(coordinator.Failure): usb.open()
        self.assertEqual(ops.events, [])

    def test_rw_noload_and_missing_safety_flags_are_not_accepted(self):
        for options in ["rw,nosuid,nodev,noexec,noload", "rw,nosuid,nodev,noexec,norecovery", "rw", "ro"]:
            ops, usb = self.setup_usb(); ops.row["options"] = options
            with self.assertRaises(coordinator.Failure): usb.require("RW" if options.startswith("rw") else "RO")

    def test_cleanup_removes_even_invalid_rw_noload_session(self):
        ops, usb = self.setup_usb(); ops.row["options"] = "rw,nosuid,nodev,noexec,noload"
        self.assertEqual(usb.close()["state"], "RO")


if __name__ == "__main__":
    unittest.main(verbosity=1)
