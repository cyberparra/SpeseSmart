#!/usr/bin/python3
"""Technical daily only. Install a root-owned copy; never run this source as sudo.

The test suite imports pure operations. The only CLI flag is --first-trial,
which requires an isolated restore on any day. No path or fixture override.
"""
import contextlib
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
from zoneinfo import ZoneInfo

CONFIG_PATH = "/etc/spesesmart/pi.json"
APP = NODE = USB_UUID = SSD_UUID = USB_MOUNT = USB_DEVICE = SSD_MOUNT = USER = HOME = BACKUP_LABEL = None
SERVICE = "spesesmart-pi.service"
INSTALLED = "/usr/local/libexec/spesesmart/pi-backup-coordinator.py"


def load_installation():
    # Privileged mount identity comes only from a protected root-owned file.
    global APP, NODE, USB_UUID, SSD_UUID, USB_MOUNT, USB_DEVICE, SSD_MOUNT, USER, HOME, BACKUP_LABEL
    for path in [Path(CONFIG_PATH), *Path(CONFIG_PATH).parents]:
        info = path.lstat()
        expected_type = stat.S_ISREG(info.st_mode) if str(path) == CONFIG_PATH else stat.S_ISDIR(info.st_mode)
        if not expected_type or info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise Failure("CONFIGURATION")
    with open(CONFIG_PATH, encoding="utf-8") as stream:
        config = json.load(stream)
    import pwd
    import ipaddress
    for key in ["mount", "node", "home", "tlsDirectory", "backupMount"]:
        value = config[key]
        if not re.fullmatch(r"/[a-zA-Z0-9_./-]+", value) or os.path.normpath(value) != value or value == "/":
            raise Failure("CONFIGURATION")
    for key in ["ssdUUID", "backupUUID"]:
        if not re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", config[key]):
            raise Failure("CONFIGURATION")
    if (config["ssdUUID"] == config["backupUUID"] or config["backupMount"].startswith(config["mount"] + "/")
            or config["backupMount"] == config["mount"] or not ipaddress.ip_address(config["ip"]).is_private
            or not re.fullmatch(r"[A-Z0-9_-]{1,16}", config["backupLabel"])):
        raise Failure("CONFIGURATION")
    account = pwd.getpwnam(config["user"])
    if account.pw_uid == 0 or account.pw_dir != config["home"]:
        raise Failure("CONFIGURATION")
    SSD_MOUNT, SSD_UUID = config["mount"], config["ssdUUID"]
    APP, NODE, USER, HOME = SSD_MOUNT + "/app", config["node"], config["user"], config["home"]
    USB_MOUNT, USB_UUID, BACKUP_LABEL = config["backupMount"], config["backupUUID"], config["backupLabel"]
    USB_DEVICE = "/dev/disk/by-uuid/" + USB_UUID


UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\Z")


class Failure(Exception):
    def __init__(self, code):
        self.code = code if re.fullmatch(r"[A-Z_]{1,40}", code) else "VALIDATION"


def clean_inactive(service):
    return (service.get("ActiveState") == "inactive" and service.get("SubState") == "dead"
            and service.get("MainPID") == "0" and service.get("Result") == "success")


def is_running(service):
    return (service.get("ActiveState") == "active" and service.get("SubState") == "running"
            and str(service.get("MainPID", "0")).isdigit() and int(service["MainPID"]) > 0
            and service.get("Result") == "success")


def same_state(first, second):
    return (first["fingerprint"] == second["fingerprint"]
            and first["configurationFingerprint"] == second["configurationFingerprint"]
            and second["pending"] == 0 and second["unknownAI"] == 0)


def history_preserved(before, after):
    return (before["repositorySHA256"] == after["repositorySHA256"]
            and all(after["sets"].get(ident) == digest for ident, digest in before["sets"].items()))


def run_job(ops, now=None, first_trial=False):
    """One maintenance transaction. No retry of backup, restore or financial calls."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    restore_due = first_trial or now.astimezone(ZoneInfo("Europe/Rome")).weekday() == 6
    report = {"status": "BLOCK", "at": now.isoformat(), "technicalOnly": True,
              "stopRequested": False, "startRequested": False, "serviceRestarted": False,
              "backupVerified": False, "firstTrial": first_trial,
              "usbClosure": "NOT ATTEMPTED", "historyPreserved": "NOT VERIFIED",
              "restoreTest": "NOT EXECUTED" if restore_due else "NOT DUE"}
    was_running = False
    frozen = None
    usb_attempted = False
    history = None
    try:
        initial = ops.preflight_readonly()  # USB already RO; no stop or mount yet.
        service = ops.service()
        was_running = is_running(service)
        if not was_running and not clean_inactive(service):
            raise Failure("SERVICE_STATE")
        history = ops.history()  # Official offline verification of every old set.
        if history["partial"]:
            raise Failure("PARTIAL_PRESENT")
        usb_attempted = True  # BEFORE command: even a failed mount may leave RW.
        ops.open_usb()
        writable = ops.preflight()
        if (initial["installationId"] != writable["installationId"]
                or initial["configurationFingerprint"] != writable["configurationFingerprint"]):
            raise Failure("CONFIGURATION_CHANGED")
        if was_running:
            report["stopRequested"] = True
            ops.stop()  # systemctl stop, existing graceful drain / TimeoutStopSec.
        if not clean_inactive(ops.service()):
            raise Failure("STOP_UNSAFE")
        candidate = ops.quiescent()  # No listeners, free existing lock, no recovery.
        if initial["configurationFingerprint"] != candidate["configurationFingerprint"]:
            raise Failure("CONFIGURATION_CHANGED")
        frozen = candidate  # An in-flight request may have completed during drain.
        report["fingerprint"] = frozen["fingerprint"]
        report["drainChangedTechnicalState"] = initial["fingerprint"] != frozen["fingerprint"]
        # Recheck destination after drain, still before creation.
        destination = ops.preflight()
        if destination["installationId"] != initial["installationId"] or not same_state(frozen, destination):
            raise Failure("SOURCE_CHANGED")
        created = ops.daily()
        if created.get("status") != "verified" or created.get("kind") != "daily" or not UUID.fullmatch(created.get("id", "")):
            raise Failure("DAILY_RESULT")
        report["backupId"] = created["id"]
        verified = ops.verify(created["id"])
        if (verified.get("fingerprint") != frozen["fingerprint"]
                or verified.get("installationId") != initial["installationId"]):
            raise Failure("BACKUP_STATE")
        report["manifestSHA256"] = verified["manifestSHA256"]
        report["createdAt"] = verified["createdAt"]
        report["backupVerified"] = True
        if restore_due:
            report["restoreTest"] = "BLOCK"
            result = ops.restore(created["id"])
            if result.get("status") != "isolated-verified" or result.get("remoteRestore") is not False:
                raise Failure("RESTORE_VALIDATION")
            report["restoreTest"] = "PASS"
        if not clean_inactive(ops.service()) or not same_state(frozen, ops.quiescent()):
            raise Failure("SOURCE_CHANGED")
        report["status"] = "PASS"
    except Exception as error:
        report["code"] = error.code if isinstance(error, Failure) else "VALIDATION"
    finally:
        if usb_attempted:
            # Historical data is verified BEFORE closing the mount. No deletion,
            # even when the failed backup left a partial or a newly published set.
            try:
                after = ops.history()
                if not history_preserved(history, after):
                    raise Failure("HISTORY_CHANGED")
                if report["status"] == "PASS" and (after["partial"] or set(after["sets"]) != set(history["sets"]) | {report["backupId"]}):
                    raise Failure("HISTORY_CHANGED")
                report["historyPreserved"] = "PASS"
            except Exception:
                report.update(status="BLOCK", historyPreserved="NOT VERIFIED")
                report.setdefault("code", "HISTORY_CHANGED")
            try:
                closure = ops.close_usb()
                report["usbClosure"] = ops.usb_closed()  # Observe, do not trust exit status.
                if closure.get("commandFailed"):
                    report.update(status="BLOCK", usbCommandError=True)
                    report.setdefault("code", "USB_COMMAND")
            except Exception:
                report.update(status="BLOCK", usbClosure="NOT VERIFIED")
                report.setdefault("code", "USB_CLEANUP")
    # Every start is AFTER verified closure, including recovery from copy errors.
    # Before-stop failures never stop production just to deal with a USB problem.
    if was_running and frozen is not None:
        try:
            if report["usbClosure"] not in {"RO", "UNMOUNTED"} or report["historyPreserved"] != "PASS":
                raise Failure("USB_CLEANUP")
            if not clean_inactive(ops.service()) or not same_state(frozen, ops.quiescent()):
                raise Failure("SOURCE_CHANGED")
            ops.usb_closed()  # Reobserve immediately before the single start.
            report["startRequested"] = True
            ops.start()
            ops.running()
            report["serviceRestarted"] = True
        except Exception as error:
            report["status"] = "BLOCK"
            report.setdefault("code", error.code if isinstance(error, Failure) else "VALIDATION")
            report["restartCheck"] = "BLOCK"
    if report["stopRequested"] and not report["serviceRestarted"]:
        report["manualCheckRequired"] = True
    return report


@contextlib.contextmanager
def coordinator_lock(path):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                or os.path.realpath(path) != path):
            raise Failure("COORDINATOR_LOCK")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Failure("BUSY") from error
        yield
    finally:
        os.close(fd)


class BackupUSB:
    """Fixed UUID only, ordinary unmounts, no repairs or fallback directories.

    This adapter MUST share PID1's mount namespace: a readonly bind in a private
    systemd namespace does not demonstrate that the host USB is readonly.
    """
    def __init__(self, ops):
        self.ops = ops
        self.device_number = None

    def mounts(self):
        result = json.loads(self.ops.command(["/usr/bin/findmnt", "--json", "--list", "--output",
                                              "TARGET,FSTYPE,UUID,LABEL,MAJ:MIN,OPTIONS"]))
        if not isinstance(result.get("filesystems"), list):
            raise Failure("USB_OBSERVATION")
        return result["filesystems"]

    def device(self):
        info = os.stat(USB_DEVICE)
        if not stat.S_ISBLK(info.st_mode):
            raise Failure("USB_IDENTITY")
        number = f"{os.major(info.st_rdev)}:{os.minor(info.st_rdev)}"
        if self.device_number is not None and self.device_number != number:
            raise Failure("USB_IDENTITY")
        self.device_number = number
        return number

    def empty_mountpoint(self):
        for path in [Path(USB_MOUNT), *Path(USB_MOUNT).parents]:
            info = path.lstat()
            if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
                    or info.st_uid != 0 or info.st_mode & 0o022):
                raise Failure("USB_MOUNTPOINT")
        if os.path.realpath(USB_MOUNT) != USB_MOUNT or os.listdir(USB_MOUNT):
            raise Failure("USB_MOUNTPOINT")

    @staticmethod
    def safe_options(row, mode):
        options = set(row.get("options", "").split(","))
        return ({mode.lower(), "nosuid", "nodev", "noexec"}.issubset(options)
                and ("rw" if mode == "RO" else "ro") not in options
                and (mode != "RW" or not {"noload", "norecovery"} & options))

    def observe(self):
        number = self.device()
        rows = self.mounts()
        mounted = [row for row in rows if row.get("target") == USB_MOUNT]
        if (len(mounted) > 1 or any(row.get("target", "").startswith(USB_MOUNT + "/") for row in rows)
                or any((row.get("maj:min") == number or row.get("uuid") == USB_UUID)
                       and row.get("target") != USB_MOUNT for row in rows)):
            raise Failure("USB_MOUNTPOINT")
        if not mounted:
            self.empty_mountpoint()
            return {"state": "UNMOUNTED"}
        row = mounted[0]
        if (row.get("uuid") != USB_UUID or row.get("label") != BACKUP_LABEL
                or row.get("fstype") != "ext4" or row.get("maj:min") != number):
            raise Failure("USB_IDENTITY")
        flags = set(row.get("options", "").split(","))
        if ("ro" in flags) == ("rw" in flags):
            raise Failure("USB_OBSERVATION")
        return {**row, "state": "RO" if "ro" in flags else "RW"}

    def require(self, mode):
        state = self.observe()
        if state["state"] != mode or (mode != "UNMOUNTED" and not self.safe_options(state, mode)):
            raise Failure("USB_MOUNT")
        return state

    def clean_device(self):
        self.require("UNMOUNTED")
        info = dict(line.split(":", 1) for line in self.ops.command(
            ["/usr/sbin/dumpe2fs", "-h", USB_DEVICE]).splitlines() if ":" in line)
        if (info.get("Filesystem state", "").strip() != "clean"
                or "needs_recovery" in info.get("Filesystem features", "").split()):
            raise Failure("USB_NOT_CLEAN")

    def open(self):
        self.require("RO")
        rows = [row for row in self.mounts() if row.get("target") == SSD_MOUNT]
        if (len(rows) != 1 or rows[0].get("uuid") != SSD_UUID or rows[0].get("fstype") != "ext4"
                or "rw" not in rows[0].get("options", "").split(",")):
            raise Failure("SSD_IDENTITY")
        # Never remount rw while retaining noload/norecovery from the RO audit.
        self.ops.command(["/usr/bin/umount", "--", USB_MOUNT])
        self.clean_device()  # Dirty filesystem blocks; no journal replay or repair.
        self.ops.command(["/usr/bin/mount", "-t", "ext4", "-o", "rw,nosuid,nodev,noexec",
                          "--", USB_DEVICE, USB_MOUNT])
        self.require("RW")

    def closed(self):
        state = self.observe()
        if state["state"] == "UNMOUNTED":
            return "UNMOUNTED"
        if state["state"] == "RO" and self.safe_options(state, "RO"):
            return "RO"
        raise Failure("USB_CLEANUP")

    def close(self):
        state = self.observe()  # May be RW even though the mount command failed.
        if state["state"] == "UNMOUNTED" or (state["state"] == "RO" and self.safe_options(state, "RO")):
            return {"state": self.closed(), "commandFailed": False}
        failed = False
        try:
            # Recheck identity immediately before acting, including failure paths.
            self.observe()
            self.ops.command(["/usr/bin/umount", "--", USB_MOUNT])
        except Exception:
            failed = True
        # An error exit does not prove that the unmount failed (or succeeded).
        if self.observe()["state"] != "UNMOUNTED":
            raise Failure("USB_CLEANUP")
        try:
            self.clean_device()
            self.ops.command(["/usr/bin/mount", "-t", "ext4", "-o", "ro,noload,nosuid,nodev,noexec",
                              "--", USB_DEVICE, USB_MOUNT])
        except Exception:
            failed = True  # A verified ordinary unmount is an acceptable fallback.
        return {"state": self.closed(), "commandFailed": failed}


class ProductionOperations:
    ENV = {"HOME": "/root", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}

    def __init__(self):
        self.usb = BackupUSB(self)
        self.unresolved_commands = []

    def no_unresolved_commands(self):
        self.unresolved_commands = [child for child in self.unresolved_commands if child.poll() is None]
        if self.unresolved_commands:
            raise Failure("COMMAND_IN_FLIGHT")

    def open_usb(self):
        self.no_unresolved_commands()
        return self.usb.open()

    def close_usb(self):
        self.no_unresolved_commands()
        return self.usb.close()

    def usb_closed(self):
        self.no_unresolved_commands()
        return self.usb.closed()

    def command(self, args, timeout=30):
        # No shell, environment inherited from the invoking terminal, raw stderr
        # or raw exception text. Timeout uses SIGTERM only, never SIGKILL.
        child = subprocess.Popen(args, cwd=APP, env=self.ENV, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            out, _ = child.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            child.send_signal(signal.SIGTERM)
            try:
                child.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                self.unresolved_commands.append(child)
                # No late mount/copy may race closure or a subsequent start.
            raise Failure("COMMAND_TIMEOUT") from error
        if child.returncode != 0:
            try:
                result = json.loads(out)
                code = result.get("code", "COMMAND_FAILED")
            except (ValueError, AttributeError):
                code = "COMMAND_FAILED"
            raise Failure(code)
        if len(out) > 128 * 1024:
            raise Failure("COMMAND_OUTPUT")
        return out

    def worker(self, action, ident=None):
        if action not in {"preflight", "preflight-readonly", "history", "quiescent", "running", "verify", "restore"}:
            raise Failure("USAGE")
        if (action in {"verify", "restore"}) != (ident is not None) or (ident is not None and not UUID.fullmatch(ident)):
            raise Failure("USAGE")
        result = json.loads(self.command(self.user_command("scripts/pi-backup-worker.mts", action, *([ident] if ident else [])), 600))
        if result.get("status") not in {"PASS", "isolated-verified"}:
            raise Failure("WORKER_RESULT")
        return result

    @staticmethod
    def user_command(script, *args):
        if script not in {"scripts/backup.mts", "scripts/pi-backup-worker.mts"}:
            raise Failure("USAGE")
        return ["/usr/sbin/runuser", "--user", USER, "--", "/usr/bin/env", "-i",
                "HOME=" + HOME, "USER=" + USER, "LOGNAME=" + USER, "LANG=C.UTF-8",
                "PATH=" + str(Path(NODE).parent) + ":/usr/sbin:/usr/bin:/sbin:/bin", "SPESESMART_PI_CONFIG=" + CONFIG_PATH,
                "NODE_ENV=production", "TSX_DISABLE_CACHE=1", NODE,
                "--env-file=" + SSD_MOUNT + "/data/production.env", "--conditions=react-server",
                "--import", "./scripts/pi-preview-network.mjs", "--import", "tsx", script, *args]

    def service(self):
        out = self.command(["/usr/bin/systemctl", "show", SERVICE, "-p", "ActiveState", "-p", "SubState",
                            "-p", "MainPID", "-p", "Result", "-p", "NRestarts"])
        return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)

    def stop(self):
        self.command(["/usr/bin/systemctl", "stop", SERVICE], 390)

    def start(self):
        self.no_unresolved_commands()
        self.command(["/usr/bin/systemctl", "start", SERVICE], 150)

    def running(self):
        deadline = time.monotonic() + 90
        while True:
            state = self.service()
            if not is_running(state) or state.get("NRestarts") != "0":
                raise Failure("START_UNSAFE")
            try:
                return self.worker("running")
            except Failure as error:
                if error.code not in {"LISTENERS", "WRITER_LOCK"} or time.monotonic() >= deadline:
                    raise
                time.sleep(1)  # Readiness observation only; never retry backup/start.

    def preflight(self):
        return self.worker("preflight")

    def preflight_readonly(self):
        self.usb.require("RO")
        return self.worker("preflight-readonly")

    def history(self):
        state = self.usb.observe()
        if state["state"] not in {"RO", "RW"}:
            raise Failure("USB_MOUNT")
        return self.worker("history")

    def quiescent(self):
        self.no_unresolved_commands()
        return self.worker("quiescent")

    def verify(self, ident):
        return self.worker("verify", ident)

    def restore(self, ident):
        return self.worker("restore", ident)

    def daily(self):
        # Exactly the official backup:daily CLI; no weekly/init/prune branch.
        return json.loads(self.command(self.user_command("scripts/backup.mts", "daily"), 600))


def installed_guard():
    if (sys.argv[1:] not in [[], ["--first-trial"]] or os.getuid() != 0 or sys.platform != "linux"
            or os.uname().machine != "aarch64"
            or os.path.abspath(__file__) != INSTALLED or os.path.realpath(__file__) != INSTALLED):
        raise Failure("INSTALLATION_REQUIRED")
    for path in [Path(INSTALLED), *Path(INSTALLED).parents]:
        info = path.lstat()
        expected_type = stat.S_ISREG(info.st_mode) if str(path) == INSTALLED else stat.S_ISDIR(info.st_mode)
        if not expected_type or stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise Failure("INSTALLATION_REQUIRED")
    if os.stat("/proc/self/ns/mnt").st_ino != os.stat("/proc/1/ns/mnt").st_ino:
        raise Failure("HOST_MOUNT_NAMESPACE")


def main():
    try:
        installed_guard()
        load_installation()
        with coordinator_lock("/run/lock/spesesmart-backup-daily.lock"):
            report = run_job(ProductionOperations(), first_trial=sys.argv[1:] == ["--first-trial"])
    except Exception as error:
        report = {"status": "BLOCK", "code": error.code if isinstance(error, Failure) else "VALIDATION", "technicalOnly": True}
    print(json.dumps(report), flush=True)
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
