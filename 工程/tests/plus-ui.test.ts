import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const flags=vi.hoisted(()=>({compress:vi.fn()}));
vi.mock('../src/core/platform',async original=>({...await original<typeof import('../src/core/platform')>(),isDesktopShell:true,isWebBuild:false,isMobile:false}));
vi.mock('../src/core/imageCompression',async original=>({...await original<typeof import('../src/core/imageCompression')>(),compressTaskImage:flags.compress}));
import { applyPlusMetadata, PLUS_OWNER_EMAIL, plusEnabled, setPlusEnabled, setPlusSession } from '../src/core/plus';
import { appStore, flushSave, useApp } from '../src/core/store';
import { defaultData, newTask, type TaskImage } from '../src/core/model';
import { syncStore } from '../src/core/syncCtl';
import { whoAmI } from '../src/core/cloud';
import TaskCard from '../src/components/TaskCard';
import Settings from '../src/views/Settings';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const bytes=[255,216,255,192,0,17,8,0,1,0,1,3,1,17,0,2,17,0,3,17,0,255,217];
const image:TaskImage&{futureField:string}={id:'old-image',name:'合成.jpg',dataUrl:'data:image/jpeg;base64,'+btoa(String.fromCharCode(...bytes)),width:1,height:1,bytes:bytes.length,futureField:'preserve exactly'};
let root:Root,host:HTMLDivElement;
const owner={email:PLUS_OWNER_EMAIL,token:'synthetic-owner'};
function grant(identity=owner,toggle=identity.email===PLUS_OWNER_EMAIL){setPlusSession(identity);applyPlusMetadata(identity.token,{email:identity.email,plus:true,plusCanToggle:toggle});}
function Card(){const task=useApp(s=>s.data.tasks[0]);return createElement(TaskCard,{task});}
function settingsAndCard(){return createElement(Fragment,null,createElement(Settings),createElement(Card));}
async function paste(){
 const event=new Event('paste',{bubbles:true,cancelable:true});const file=new File(['synthetic'],'local.png',{type:'image/png'});
 Object.defineProperty(event,'clipboardData',{value:{files:[file],items:[{kind:'file',type:'image/png',getAsFile:()=>file}],getData:()=>''}});
 await act(async()=>document.querySelector('.task-card .row1 textarea')!.dispatchEvent(event));
}
beforeEach(async()=>{
 await flushSave();localStorage.clear();setPlusSession(null);syncStore.setState({session:null});
 vi.spyOn(navigator,'userAgent','get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
 vi.stubGlobal('fetch',vi.fn(()=>Promise.reject(new Error('All external requests blocked in synthetic test'))));
 vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
 flags.compress.mockReset().mockResolvedValue({...image,id:'new-image'});
 const data=defaultData();data.settings.mode='light';data.tasks=[newTask({id:'plus-test',title:'合成任务',images:[image],subtasks:[{id:'child',title:'合成步骤',done:false,due:null,dueTime:null,priority:null,images:[image]}]})];
 appStore.setState({data,loaded:true,loadError:null,wiped:false});host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{act(()=>root.unmount());host.remove();setPlusSession(null);await flushSave();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('reactive Plus features in one common package',()=>{
 it('only trusted owner sees a local switch; off immediately hides images, on restores original fields without ledger writes',async()=>{
  await act(async()=>root.render(settingsAndCard()));expect(document.querySelector('[aria-label="Plus功能"]')).toBeNull();expect(document.querySelector('[data-image-summary]')).toBeNull();
  act(()=>grant());const before=JSON.stringify(appStore.getState().data);expect(document.querySelectorAll('[data-image-summary]')).toHaveLength(2);
  const toggle=document.querySelector<HTMLButtonElement>('[aria-label="Plus功能"]')!;expect(toggle.getAttribute('aria-checked')).toBe('true');
  act(()=>toggle.click());expect(plusEnabled()).toBe(false);expect(document.querySelector('[data-image-summary]')).toBeNull();expect(document.querySelector('[data-image-picker]')).toBeNull();
  expect(JSON.stringify(appStore.getState().data)).toBe(before);expect(toggle.getAttribute('aria-checked')).toBe('false');
  act(()=>toggle.click());expect(document.querySelectorAll('[data-image-summary]')).toHaveLength(2);expect(JSON.stringify(appStore.getState().data)).toBe(before);
 });
 it('future non-owner Plus users unlock images with no switch; switch to ordinary user hides all image UI without deleting data',async()=>{
  await act(async()=>{grant({email:'future@example.test',token:'synthetic-future'},true);root.render(settingsAndCard())});
  expect(document.querySelector('[data-image-summary]')).not.toBeNull();expect(document.querySelector('[aria-label="Plus功能"]')).toBeNull();
  const before=JSON.stringify(appStore.getState().data);act(()=>setPlusSession({email:'ordinary@example.test',token:'synthetic-ordinary'}));
  expect(document.querySelector('[data-image-summary],[data-image-picker],[data-task-images]')).toBeNull();expect(JSON.stringify(appStore.getState().data)).toBe(before);
 });
 it('turning Plus off and back on while compression is pending invalidates that operation permanently',async()=>{
  let finish!:(image:TaskImage)=>void;flags.compress.mockImplementation(()=>new Promise<TaskImage>(resolve=>finish=resolve));
  act(()=>{grant();root.render(createElement(Card))});const before=JSON.stringify(appStore.getState().data.tasks[0].images);await paste();
  act(()=>{setPlusEnabled(false);setPlusEnabled(true)});await act(async()=>finish({...image,id:'must-not-arrive'}));
  expect(JSON.stringify(appStore.getState().data.tasks[0].images)).toBe(before);expect(document.querySelector('[role="status"]')).toBeNull();
 });
 it('logout while the file chooser is open rejects its eventual change and reopening same account restores existing images',async()=>{
  act(()=>{grant();root.render(createElement(Card))});const button=document.querySelector<HTMLButtonElement>('.sub-image-add')!;
  const input=document.querySelector<HTMLInputElement>('[data-image-picker]')!;act(()=>button.click());act(()=>setPlusSession(null));
  Object.defineProperty(input,'files',{configurable:true,value:[new File(['synthetic'],'late.png',{type:'image/png'})]});
  await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));expect(flags.compress).not.toHaveBeenCalled();
  act(()=>grant());expect(appStore.getState().data.tasks[0].subtasks[0].images).toEqual([image]);expect(document.querySelector('[data-image-summary]')).not.toBeNull();
 });
 it('real cloud me metadata is bound to the request token, ignores an old account response and supports legacy ultra',async()=>{
  setPlusSession(owner);let reply!:(value:Response)=>void;const fetcher=vi.fn(()=>new Promise<Response>(resolve=>reply=resolve));vi.stubGlobal('fetch',fetcher);
  const request=whoAmI(owner.token);await Promise.resolve();setPlusSession({email:'new@example.test',token:'synthetic-new'});
  reply({ok:true,status:200,text:async()=>JSON.stringify({email:owner.email,plus:true,plusCanToggle:true})} as Response);await request;expect(plusEnabled()).toBe(false);
  setPlusSession(owner);fetcher.mockImplementation(async()=>({ok:true,status:200,text:async()=>JSON.stringify({email:owner.email,ultra:true})} as Response));await whoAmI(owner.token);expect(plusEnabled()).toBe(true);
  expect(document.querySelector('[aria-label="Plus功能"]')).toBeNull();
 });
});
