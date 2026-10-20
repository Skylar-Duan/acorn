import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/core/platform',async original=>({...await original<typeof import('../src/core/platform')>(),isDesktopShell:true,isWebBuild:false,isMobile:false}));
vi.mock('../src/core/cloud',async original=>({...await original<typeof import('../src/core/cloud')>(),loadSession:vi.fn(),saveSession:vi.fn(async()=>{}),syncOnce:vi.fn(async(_session,data)=>({rev:1,data,changed:false,summary:{added:0,updated:0,removed:0}}))}));
import * as cloud from '../src/core/cloud';
import { adoptSession, initSync, signOut, stopAutoPull, syncStore } from '../src/core/syncCtl';
import { applyPlusMetadata, plusEnabled, setPlusSession } from '../src/core/plus';
import { appStore, flushSave } from '../src/core/store';
import { defaultData } from '../src/core/model';
const identity={email:'synthetic@example.test',token:'synthetic-only',rev:1,syncedAt:null};
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve()};
beforeEach(async()=>{
 vi.mocked(cloud.saveSession).mockResolvedValue(undefined);await signOut();await flushSave();localStorage.clear();setPlusSession(null);
 vi.spyOn(navigator,'userAgent','get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0)');
 vi.mocked(cloud.loadSession).mockResolvedValue(identity);appStore.setState({data:defaultData(),loaded:true,loadError:null,rescue:null,noDataFile:false,wiped:false});
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,text:async()=>JSON.stringify({email:identity.email,plus:true,plusCanToggle:false})})));
});
afterEach(async()=>{vi.mocked(cloud.saveSession).mockResolvedValue(undefined);await signOut();stopAutoPull();await settle();await flushSave();vi.restoreAllMocks();vi.unstubAllGlobals()});
describe('real session lifecycle refreshes and invalidates Plus',()=>{
 it('initSync loads the account then applies real GET/me metadata without tying it to a build edition',async()=>{
  await initSync();await settle();expect(syncStore.getState().session?.email).toBe(identity.email);expect(plusEnabled()).toBe(true);
  expect(vi.mocked(fetch).mock.calls.some(([url])=>String(url).endsWith('/api/me'))).toBe(true);
 });
 it('same-account offline boot retains cached grant and does not interpret network failure as revocation',async()=>{
  setPlusSession(identity);applyPlusMetadata(identity.token,{email:identity.email,plus:true});setPlusSession(null);
  vi.stubGlobal('fetch',vi.fn(()=>Promise.reject(new TypeError('offline synthetic'))));await initSync();await settle();expect(plusEnabled()).toBe(true);
 });
 it('signOut hides immediately before credential persistence finishes and ignores old metadata',async()=>{
  syncStore.setState({session:identity});applyPlusMetadata(identity.token,{email:identity.email,plus:true});expect(plusEnabled()).toBe(true);
  let finish!:()=>void;vi.mocked(cloud.saveSession).mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));
  const signingOut=signOut();expect(plusEnabled()).toBe(false);expect(applyPlusMetadata(identity.token,{email:identity.email,plus:true})).toBe(false);
  finish();await signingOut;expect(plusEnabled()).toBe(false);
 });
 it('adoptSession clears previous identity immediately before awaiting a save and ordinary me stays hidden',async()=>{
  syncStore.setState({session:identity});applyPlusMetadata(identity.token,{email:identity.email,plus:true});
  const ordinary={...identity,email:'ordinary@example.test',token:'new-synthetic'};let finish!:()=>void;
  vi.mocked(cloud.saveSession).mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,text:async()=>JSON.stringify({email:ordinary.email,plus:false,plusCanToggle:false})})));
  const adopting=adoptSession(ordinary,{sync:false});expect(plusEnabled()).toBe(false);finish();await adopting;await settle();expect(plusEnabled()).toBe(false);
 });
 it('an explicit unauthorized me response hides a cached grant while a transport failure above does not',async()=>{
  setPlusSession(identity);applyPlusMetadata(identity.token,{email:identity.email,plus:true});setPlusSession(null);
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:401,text:async()=>JSON.stringify({error:'bad_token'})})));
  await initSync();await settle();expect(plusEnabled()).toBe(false);
 });
 it('a pending adopt save cannot restore the old session after signOut completed',async()=>{
  let finish!:()=>void;vi.mocked(cloud.saveSession).mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));
  const adopting=adoptSession(identity,{sync:false});await signOut();finish();await adopting;
  expect(syncStore.getState().session).toBeNull();expect(plusEnabled()).toBe(false);
 });
 it('a delayed startup session read cannot overwrite a login completed meanwhile',async()=>{
  let finish!:(value:typeof identity)=>void;vi.mocked(cloud.loadSession).mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));
  const boot=initSync();const next={...identity,email:'new-login@example.test',token:'new-synthetic'};
  await adoptSession(next,{sync:false});finish(identity);await boot;expect(syncStore.getState().session?.token).toBe(next.token);
 });
 it('a pending expiry save cannot erase a newer completed login',async()=>{
  const {expireSession}=await import('../src/core/syncCtl');let finish!:()=>void;
  vi.mocked(cloud.saveSession).mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));const expiring=expireSession();
  const next={...identity,email:'new-login@example.test',token:'new-synthetic'};await adoptSession(next,{sync:false});finish();await expiring;
  expect(syncStore.getState().session?.token).toBe(next.token);
 });
 it('failed credential save restores the previous capability identity rather than leaking the attempted new account',async()=>{
  syncStore.setState({session:identity});applyPlusMetadata(identity.token,{email:identity.email,plus:true});
  vi.mocked(cloud.saveSession).mockRejectedValueOnce(new Error('synthetic disk failure'));
  await expect(adoptSession({...identity,email:'other@example.test',token:'other-synthetic'},{sync:false})).rejects.toThrow('disk failure');
  expect(syncStore.getState().session?.token).toBe(identity.token);expect(plusEnabled()).toBe(true);
 });
});
