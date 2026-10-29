import { z } from "zod";
import type { EditablePurchase } from "./purchase-edit";

export const DeleteRequestSchema = z.object({
  documentId: z.string().min(1).max(200), operationId: z.uuid(),
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true),
}).strict();
export type DeleteRequest = z.infer<typeof DeleteRequestSchema>;
export type PendingPurchaseDeletion = { editable: EditablePurchase; request: DeleteRequest };
