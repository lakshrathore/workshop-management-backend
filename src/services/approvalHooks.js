// ── Approval Reject Hooks (NEW FILE — Phase 1 Main PO) ───────────────────────
// Generic, additive registry. approvalService.rejectRequest() calls
// runRejectHook(approval, adminId, reason) inside a try/catch AFTER the
// approval row is marked REJECTED.
//
// SAFETY: types with no registered hook (PROJECT, ITEM, CHALLAN, PO_STATUS,
// SALE) hit `if (!hook) return;` — their reject path is byte-for-byte
// unchanged. A hook error is caught by the caller and can never fail a reject.

const REJECT_HOOKS = {};

function registerRejectHook(type, fn) {
  REJECT_HOOKS[type] = fn;
}

async function runRejectHook(approval, adminId, reason) {
  const hook = REJECT_HOOKS[approval.type];
  if (!hook) return;
  await hook(approval, adminId, reason);
}

module.exports = { registerRejectHook, runRejectHook, REJECT_HOOKS };
