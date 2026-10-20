import { describe, expect, it } from "vitest";
import { createPlusController, PLUS_OWNER_EMAIL } from "../src/core/plus";

const user = { email: "person@example.test", token: "synthetic-only" };
const owner = { email: PLUS_OWNER_EMAIL, token: "synthetic-owner" };
function fixture(supported = true, values = new Map<string, string>()) {
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  return { ...createPlusController({ supported: () => supported, storage: () => storage }), values };
}
describe("Plus is account entitlement independent from version channels", () => {
  it("no session and an unverified local owner email cannot create entitlement or toggle", () => {
    const plus = fixture();
    expect(plus.store.getState().enabled).toBe(false);
    plus.setSession(owner);
    expect(plus.store.getState()).toMatchObject({ enabled: false, canToggle: false });
    expect(plus.setEnabled(true)).toBe(false);
  });
  it("trusted plus metadata takes precedence over legacy ultra and is bound to token and normalized email", () => {
    const plus = fixture();plus.setSession(user);
    expect(plus.applyMetadata("old-token", { email: user.email, plus: true })).toBe(false);
    expect(plus.applyMetadata(user.token, { email: "other@example.test", plus: true })).toBe(false);
    expect(plus.applyMetadata(user.token, { email: " PERSON@EXAMPLE.TEST ", plus: false, ultra: true })).toBe(true);
    expect(plus.store.getState().enabled).toBe(false);
    plus.applyMetadata(user.token, { email: user.email, ultra: true });
    expect(plus.store.getState()).toMatchObject({ enabled: true, entitled: true, canToggle: false });
  });
  it("same account offline cache survives a new controller / version; logout and another account immediately hide it", () => {
    const first = fixture();first.setSession(user);first.applyMetadata(user.token, { email: user.email, plus: true });
    const nextVersion = fixture(true, first.values);nextVersion.setSession(user);
    expect(nextVersion.store.getState().enabled).toBe(true);
    const revision = nextVersion.store.getState().revision;
    nextVersion.setSession(null);
    expect(nextVersion.store.getState().enabled).toBe(false);
    expect(nextVersion.store.getState().revision).toBeGreaterThan(revision);
    nextVersion.setSession({ email: "other@example.test", token: "different-synthetic" });
    expect(nextVersion.store.getState().enabled).toBe(false);
    expect(nextVersion.applyMetadata(user.token, { email: user.email, plus: true })).toBe(false);
    nextVersion.setSession(user);expect(nextVersion.store.getState().enabled).toBe(true);
    expect([...first.values.values()].join()).not.toContain(user.token);
  });
  it("only trusted owner gets toggle; defaults on, off persists per account across beta/stable and metadata refresh", () => {
    const plus = fixture();plus.setSession(owner);plus.applyMetadata(owner.token, { email: owner.email, plus: true, plusCanToggle: true });
    expect(plus.store.getState()).toMatchObject({ enabled: true, canToggle: true });
    expect(plus.setEnabled(false)).toBe(true);
    plus.applyMetadata(owner.token, { email: owner.email, plus: true, plusCanToggle: true });
    expect(plus.store.getState()).toMatchObject({ enabled: false, entitled: true });
    const stable = fixture(true, plus.values);stable.setSession(owner);expect(stable.store.getState().enabled).toBe(false);
    stable.setEnabled(true);expect(stable.store.getState().enabled).toBe(true);
    stable.setSession(user);stable.applyMetadata(user.token, { email: user.email, plus: true, plusCanToggle: true });
    expect(stable.store.getState()).toMatchObject({ enabled: true, canToggle: false });
    expect(stable.setEnabled(false)).toBe(false);
  });
  it("server revocation clears same-account offline grant and owner toggle", () => {
    const plus = fixture();plus.setSession(owner);plus.applyMetadata(owner.token, { email: owner.email, plus: true, plusCanToggle: true });
    plus.applyMetadata(owner.token, { email: owner.email, plus: false, plusCanToggle: false });
    expect(plus.store.getState()).toMatchObject({ entitled: false, enabled: false, canToggle: false });
    const restart = fixture(true, plus.values);restart.setSession(owner);expect(restart.store.getState().enabled).toBe(false);
  });
  it("non-Windows/browser/mobile host stays hidden even with entitlement; window context never persists a grant", () => {
    const plus = fixture(false);plus.setSession(owner);plus.applyMetadata(owner.token, { email: owner.email, plus: true, plusCanToggle: true });
    expect(plus.store.getState().enabled).toBe(false);
    const window = fixture();window.setWindowContext(true);expect(window.store.getState()).toMatchObject({ enabled: true, canToggle: false, account: null });
    window.setWindowContext(false);expect(window.store.getState().enabled).toBe(false);expect(window.values.size).toBe(0);
  });
  it("invalid or cross-account cache fails closed; disk failure does not undo the current owner's off preference", () => {
    const values = new Map([["acorn-plus-entitlement:" + user.email, JSON.stringify({ version: 1, account: owner.email, entitled: true, canToggle: true })]]);
    const plus = fixture(true, values);plus.setSession(user);expect(plus.store.getState().enabled).toBe(false);
    const broken = createPlusController({ supported: () => true, storage: () => ({ getItem: () => null, setItem: () => { throw new Error("full"); } }) });
    broken.setSession(owner);broken.applyMetadata(owner.token, { email: owner.email, plus: true, plusCanToggle: true });broken.setEnabled(false);
    broken.applyMetadata(owner.token, { email: owner.email, plus: true, plusCanToggle: true });expect(broken.store.getState().enabled).toBe(false);
  });
  it("off→on or logout→login still changes revision, invalidating a captured operation even when final enabled matches", () => {
    const plus = fixture();plus.setSession(owner);plus.applyMetadata(owner.token, { email: owner.email, plus: true, plusCanToggle: true });
    const before = plus.store.getState().revision;plus.setEnabled(false);plus.setEnabled(true);expect(plus.store.getState().revision).toBeGreaterThan(before);
    const after = plus.store.getState().revision;plus.setSession(null);plus.setSession(owner);expect(plus.store.getState().enabled).toBe(true);expect(plus.store.getState().revision).toBeGreaterThan(after);
  });
  it("an old me response cannot revive or revoke a new login even if that login reused the same token", () => {
    const plus=fixture();plus.setSession(user);const receiveOld=plus.metadataReceiver(user.token);
    plus.setSession(null);plus.setSession(user);plus.applyMetadata(user.token,{email:user.email,plus:true});
    expect(receiveOld({email:user.email,plus:false})).toBe(false);expect(plus.store.getState().enabled).toBe(true);
  });
});
