// VERBATIM copy of the legacy deduplication code from the original index.html.
// Kept only so tests/legacy-repro.test.js can demonstrate the original failure. Not used by the app.

const okUrl=u=>{try{const x=new URL(u);return(/^https?:$/.test(x.protocol)&&!x.username&&!x.password&&x.hostname.includes('.'))?x.href:null}catch(e){return null}};
const nu=u=>{try{const x=new URL(u);return x.hostname.replace(/^www\./,'')+x.pathname.replace(/\/$/,'')}catch(e){return String(u)}};
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/\b(j p morgan|jp morgan|jpmorgan chase)\b/g,'jpmorgan').replace(/\b(sa|sas|ltd|plc|gmbh|ag|inc|llc|nv|bv|group|groupe|co)\b/g,' ').replace(/\bib\b/g,'investment banking').replace(/\b(internship|stagiaire|stage)\b/g,'intern').replace(/[^a-z0-9]+/g,' ').trim();
const keysOf=x=>['p:'+x.providerJobId,'u:'+nu(x.canonicalUrl),...x.sources.map(s=>s.applyUrl&&'a:'+nu(s.applyUrl)),'c:'+norm(x.companyName)+'|'+norm(x.roleTitle)+'|'+norm(x.city)].filter(k=>k&&!/:null$/.test(k));
const sim=(a,b)=>{if(norm(a.companyName)!==norm(b.companyName)||(a.city&&b.city&&norm(a.city)!==norm(b.city)))return false;const A=new Set(norm(a.roleTitle).split(' ')),B=new Set(norm(b.roleTitle).split(' ')),i=[...A].filter(t=>B.has(t)).length;return i/(new Set([...A,...B]).size)>=.8};
const unionS=(a,b)=>{const o=[...a];b.forEach(s=>{if(!o.some(t=>t.label===s.label&&nu(t.url)===nu(s.url)))o.push(s)});return o};
function mergeInto(a,b){a.sources=unionS(a.sources,b.sources);for(const k of Object.keys(b)){if(k==='sources'||k==='flags')continue;if(a[k]==null||a[k]===''||(k==='description'&&(b[k]||'').length>(a[k]||'').length))a[k]=b[k]}a.dataQualityScore=Math.max(a.dataQualityScore,b.dataQualityScore)}
function dedupe(list){const out=[];let rm=0;list.forEach(x=>{const m=out.find(y=>keysOf(y).some(k=>keysOf(x).includes(k))||sim(y,x));if(m){rm++;mergeInto(m,x)}else out.push(x)});return{out,rm}}
export {okUrl,nu,norm,keysOf,sim,unionS,mergeInto,dedupe};
