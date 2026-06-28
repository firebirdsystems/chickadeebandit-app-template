import { describe, test, expect } from "vitest";
import { testPrivilegedGateContract } from "./helpers/privileged-gate.mjs";

// ── Reference fixtures ────────────────────────────────────────────────────────
const GROUPS = [{ id: "g-priv", name: "Board", memberIds: ["m-in"] }];
const FX = {
  member:   { id: "m-in",  role: "adult" }, // adult IN the configured group
  outsider: { id: "m-out", role: "adult" }, // adult NOT in the configured group
  groups:   GROUPS,
  groupId:  "g-priv",
};

// ✅ Reference CORRECT gate — copy this shape for any app gate that fronts an
// `insert_privileged_only` / `write_privileged_only` table. It mirrors the hub's
// `memberInAppGroupSetting`: privileged IFF the configured group exists and the
// caller is in it, with NO "all adults" fallback when unconfigured.
export function privilegedGate(member, groups, groupId) {
  if (!member || !groupId) return false;
  const g = groups.find((x) => x.id === groupId);
  return !!g && g.memberIds.includes(member.id);
}

testPrivilegedGateContract("reference gate", privilegedGate, FX);

// ── The helper must catch the anti-pattern ────────────────────────────────────
// If the contract didn't fail the "adult fallback when unconfigured" gate, it
// would give false assurance. Prove the divergence the contract guards against.
describe("the contract rejects the adult-fallback anti-pattern", () => {
  // ❌ The bug we shipped: privileged for any adult when no group is configured.
  function buggyGate(member, groups, groupId) {
    if (!member) return false;
    const g = groupId ? groups.find((x) => x.id === groupId) : null;
    if (g) return g.memberIds.includes(member.id);
    return member.role === "adult"; // ← the divergence from the hub
  }

  test("buggy gate is privileged with no group; correct gate is not", () => {
    // The contract asserts gate(member, groups, "") === false. The buggy gate
    // returns true, so an app shipping it would fail this helper — exactly the
    // pre-fix state of document-library / amenity-reservations / arch-review.
    expect(buggyGate(FX.member, GROUPS, "")).toBe(true);
    expect(privilegedGate(FX.member, GROUPS, "")).toBe(false);
  });
});
