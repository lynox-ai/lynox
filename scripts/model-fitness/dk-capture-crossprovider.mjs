/**
 * dk-capture-crossprovider — the SAME A/B as dk-capture-repro.mjs, but swept over
 * several models through one engine's balanced slot. A prompt change is a
 * behaviour change, so it gets validated on more than the model that happened to
 * expose it (memory/fb_validate_prompt_change.md).
 *
 * ⚠ THE TRAP THIS SCRIPT EXISTS TO AVOID (hit on 2026-08-10, both directions):
 * durable knowledge PERSISTS on the tenant. Re-run the same fact and the model
 * dedups or simply knows it already — you then measure deduplication and read it
 * as "capture broke". Worse, model 1 poisons model 2's cell within one sweep.
 * So every (model, probe) cell gets its OWN never-before-seen fact. If you add
 * cells, add facts.
 *
 * Reads the target's config, swaps the balanced slot per model, restores it in a
 * finally, and verifies from the debug-export that the run was actually SERVED by
 * the candidate. Requires `durable_memory_enabled` on the target.
 *
 * Usage:
 *   LYNOX_BASE=<engine url> LYNOX_COOKIE=<lynox_session value> \
 *     node scripts/model-fitness/dk-capture-crossprovider.mjs
 */
// Nachher-Repro über MEHRERE Provider: der Fix muss cross-provider wirken.
const BASE=process.env.LYNOX_BASE; const COOKIE=process.env.LYNOX_COOKIE;
if(!BASE||!COOKIE){console.error('set LYNOX_BASE and LYNOX_COOKIE');process.exit(1);}
const FW='https://api.fireworks.ai/inference/v1', MI='https://api.mistral.ai/v1';
const MODELS=[
  {name:'kimi-k3',   id:'accounts/fireworks/models/kimi-k3',  base:FW},
  {name:'glm-5p2',   id:'accounts/fireworks/models/glm-5p2',  base:FW},
  {name:'mistral-medium', id:'mistral-medium-2604',           base:MI},
];
// Jede Zelle bekaeme sonst einen Fakt, den eine fruehere Zelle schon gespeichert hat —
// dann misst man Deduplizierung statt Capture. Pro (Modell, Sonde) ein EIGENER frischer Fakt.
import {runToken,freshName,freshUid,sawDedup} from './probe-freshness.mjs';
// Fresh PER RUN as well as per cell. Per-cell freshness (below) stops model 1 poisoning
// model 2 inside one sweep; it does nothing about the previous sweep, whose rows are still
// active on the tenant and are dedup candidates for the same subject. The name carries the
// freshness because the store selects candidates by SUBJECT (probe-freshness.mjs).
const FIRMEN=[['Falkenstein','CHE-118.204.551','04.09.2017','Luzern','85 000'],
              ['Rietberg','CHE-330.771.902','19.01.2021','Aarau','120 000'],
              ['Talgarten','CHE-472.019.338','27.06.2015','Chur','200 000'],
              ['Seehalde','CHE-265.883.147','11.11.2019','Thun','60 000'],
              ['Moosbrugg','CHE-509.412.776','02.02.2022','Sitten','95 000'],
              ['Weidmatt','CHE-183.657.024','30.05.2018','Baden','140 000']];
let CELL=0;
const nextFact=()=>{const row=FIRMEN[CELL];
  // The header promises "if you add cells, add facts" and nothing enforced it. Today the fit
  // is exact (3 models x 2 probes = 6 facts), so this path is unreachable — it is the LATENT
  // fault the promise leaves open, not something that has happened: add a model and the next
  // cell would destructure `undefined` and throw mid-sweep, after the config was swapped.
  // Fail with the arithmetic instead of a TypeError.
  if(!row) throw new Error(`nextFact: cell ${CELL+1} has no fact — FIRMEN holds ${FIRMEN.length}, the sweep needs MODELS*PROBES`);
  const [n,uid,d,ort,kap]=row; CELL++;
  return `Die ${freshName(n)} Immobilien AG hat die UID ${freshUid(CELL)} und ist seit dem ${d} im Handelsregister ${ort} eingetragen, Aktienkapital CHF ${kap}.`;};
const PROBES=[
  {key:'A-plain',    build:(f)=>`Zur Info: ${f}`},
  {key:'C-research', build:(f)=>`Recherchier bitte kurz im Web, was eine UID im Schweizer Handelsregister ist. Und zur Info: ${f}`},
];
async function api(p,i){return fetch(BASE+p,{...i,headers:{Cookie:`lynox_session=${COOKIE}`,...(i?.body?{'Content-Type':'application/json'}:{}),...i?.headers}});}
async function cfg(){return (await (await api('/api/config')).json());}
async function swap(m,orig){
  const ts={...(orig.tier_set??{})}; ts.balanced={provider:'openai',model_id:m.id,api_base_url:m.base};
  const r=await api('/api/config',{method:'PUT',body:JSON.stringify({routing_mode:'hybrid',tier_set:ts})});
  if(!r.ok) throw new Error(`swap ${m.name} → ${r.status}`);
}
(async()=>{
  const orig=await cfg(); const out=[];
  try{
    for(const m of MODELS){
      await swap(m,orig);
      for(const p of PROBES){
        const s=await (await api('/api/sessions',{method:'POST',body:JSON.stringify({source:'user'})})).json();
        const sid=s.sessionId??s.id??s.threadId;
        const r=await api(`/api/sessions/${sid}/run`,{method:'POST',body:JSON.stringify({task:p.build(nextFact())})});
        // A run cut off by the deadline exports mid-stream and reads as remember=0 —
        // indistinguishable from "the model chose not to record". Mark the cell.
        let timedOut=false;
        const rd=r.body?.getReader(); if(rd){const dl=Date.now()+200000;try{let done=false;while(!done){if(Date.now()>dl){timedOut=true;break;}({done}=await rd.read());}}finally{rd.releaseLock();}}
        const e=await (await api(`/api/threads/${sid}/debug-export`)).json();
        const served=(e.runs?.[0]?.model_id||'?');
        const tools=(e.messages??[]).flatMap(x=>(x.toolCalls??[]).map(t=>t.name));
        const rem=tools.filter(t=>t==='remember').length;
        const res=(e.messages??[]).flatMap(x=>(x.toolCalls??[]).filter(t=>t.name==='remember').map(t=>String(t.result??'').slice(0,80)));
        const row={model:m.name, probe:p.key, run:runToken(), timedOut, served:served.split('/').pop(), servedOk:served===m.id, remember:rem, web:tools.includes('web_research'), ...(res.some(sawDedup)?{DEDUPED:true}:{}), result:res};
        out.push(row); console.log(JSON.stringify(row));
      }
    }
  } finally {
    // A silent restore failure leaves a FOREIGN model pinned on a live engine —
    // check it, say so loudly, and print the original tier_set to restore by hand.
    const rr=await api('/api/config',{method:'PUT',body:JSON.stringify({routing_mode:orig.routing_mode??'hybrid',tier_set:orig.tier_set??{}})});
    if(!rr.ok){
      console.error(`!!! CONFIG RESTORE FAILED (${rr.status}) — the engine is still pinned to the last candidate.`);
      console.error('restore this tier_set by hand:', JSON.stringify(orig.tier_set??{}));
      process.exitCode=1;
    } else { console.log('--- config restored ---'); }
    console.log(`MATRIX (run ${runToken()}):`); for(const r of out) console.log(`  ${r.model.padEnd(15)} ${r.probe.padEnd(11)} remember=${r.remember}${r.timedOut?' (TIMEOUT — Zelle ungültig)':''}${r.DEDUPED?' (DEDUPED — Zelle ungültig, Frische hat versagt)':''} web=${r.web?'ja':'nein'} served=${r.servedOk?'ok':'MISMATCH:'+r.served}`);
  }
})();
