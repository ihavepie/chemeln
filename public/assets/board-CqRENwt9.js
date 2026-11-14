import{v as N}from"./sctfields-BLW83_8w.js";const z={a4p:{w:2100,h:2970,label:"A4 竖"},a4l:{w:2970,h:2100,label:"A4 横"}},_=25.4/96,q=t=>`${(t/10).toFixed(2)}mm`,R=(t=1)=>_/.1/(t||1),D=(t=1)=>.1*(1/_)*(t||1),j=45;function E(t,e,o,n=j){const s=Math.round(o/2),r=[[0,0],[Math.round((o-e)/2),s],[o-e,o]];for(const[l,b]of r)if(Math.abs(t-l)<=n)return{x:l,line:b};return{x:t,line:null}}const G=240,I=(t,e,o)=>Math.min(o,Math.max(e,t)),X=()=>`i${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`,J=[{key:"title",label:"编号",w:1200},{key:"react",label:"反应式",w:1300},{key:"conds",label:"条件",w:1400},{key:"reagents",label:"投料",w:1500},{key:"result",label:"结果",w:1300},{key:"verdict",label:"TLC 判断",w:1400},{key:"compare",label:"对比表",w:1700},{key:"concl",label:"结论",w:1600},{key:"notes",label:"结论",w:1400}];function P(t,e){const o=Math.max(1,(t.w||100)/10),n=Math.max(1,(t.h||200)/10),s=t.up===void 0||t.up===null,r=t.dir==="left"?-1:1,l=s?{x:r>0?o:0,y:n/2}:{x:r>0?o:0,y:t.up?0:n},b=s?{x:r>0?0:o,y:n/2}:{x:r>0?0:o,y:t.up?n:0},u=t.thick?4.4:3,p=t.thick?2.6:1.6,i=t.thick?1.1:.55,m=l.x-b.x,h=l.y-b.y,y=Math.hypot(m,h)||1,$=m/y,w=h/y,f=l.x-$*u,g=l.y-w*u,k=-w*p,S=$*p,d=F=>F.toFixed(2),M=`${d(l.x)},${d(l.y)} ${d(f+k)},${d(g+S)} ${d(f-k)},${d(g-S)}`;return`<svg class="bd-arrow-svg${t.thick?" is-thick":""}" viewBox="0 0 ${d(o)} ${d(n)}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><line x1="${d(b.x)}" y1="${d(b.y)}" x2="${d(f)}" y2="${d(g)}" stroke="${a(e)}" stroke-width="${i}" stroke-linecap="round"/><polygon points="${M}" fill="${a(e)}"/></svg>`}const a=t=>String(t??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"),c=(t,e=2)=>{const o=Number(t);return Number.isFinite(o)?String(Number(o.toFixed(e))):""},L=t=>{const e=Number(t&&t.eq);return!Number.isFinite(e)||e<=0?"":e<1?`${c(e*100,0)} mol%`:`${c(e,2)} eq`},B=t=>{if(!t)return"";if(Number.isFinite(Number(t.volume_ul))&&t.volume_ul!=null){const e=Number(t.volume_ul);return e>=1e3?`${c(e/1e3,2)} mL`:`${c(e,0)} µL`}if(Number.isFinite(Number(t.mass_mg))&&t.mass_mg!=null){const e=Number(t.mass_mg);return e>=1e3?`${c(e/1e3,3)} g`:`${c(e,1)} mg`}return""},x=t=>String((t.reagents||[]).find(e=>e.role==="溶剂"&&e.name)?.name||t.solvent||"").trim(),v=t=>t.filter(([,e])=>String(e||"").trim()).map(([e,o])=>`<span class="k">${e}</span>${a(o)}`).join('<span class="sep">·</span>');function C(t,e){if(!e)return'<div class="bd-ph">（记录还没读到）</div>';switch(t){case"react":return`<img src="/api/experiments/${e.id}/scheme.svg" alt="">`;case"title":{const o=[e.code,e.title].filter(Boolean).join(" · "),n=[e.date,e.kind,e.status].filter(Boolean).join(" · ");return`<div class="bd-h1">${a(o)}</div>${n?`<div class="bd-sub">${a(n)}</div>`:""}`}case"conds":{const o=[x(e),e.temperature,e.duration,e.atmosphere,e.apparatus,e.light,e.base_mmol!=null?`${c(e.base_mmol,3)} mmol`:""].map(n=>String(n||"").trim()).filter(Boolean).join(" · ");return`<div class="bd-kv">${v([["条件",o]])}</div>`}case"reagents":{const o=(e.reagents||[]).filter(s=>String(s.name||"").trim());return o.length?`<table class="bd-tb"><thead><tr><th>组分</th><th>试剂</th><th class="n">当量</th><th class="n">用量</th></tr></thead><tbody>${o.map(s=>`<tr><td class="role">${a(s.role)}</td><td>${a(s.name)}</td><td class="n">${a(L(s))}</td><td class="n amt">${a(B(s))}</td></tr>`).join("")}</tbody></table>`:'<div class="bd-ph">（投料表是空的）</div>'}case"result":{const o=String(e.dr_ee||"").trim()||(e.ee_pct!=null?`${c(e.ee_pct,1)}% ee`:""),n=Number(e.no_yield)===1?"不计":e.yield_pct!=null?`${c(e.yield_pct,1)}%`:"",s=e.product_mass!=null?`${c(e.product_mass,4)} g`:"",r=v([["产物",e.product_name],["产率",n],["选择性",o],["质量",s]]);return r?`<div class="bd-kv">${r}</div>`:'<div class="bd-ph">（还没有结果）</div>'}case"verdict":{const o=String(e.tlc_verdict||"").trim(),n=String(e.tlc_note||"").trim(),s=v([["TLC 判断",o],["展开剂 / Rf",n]]);return s?`<div class="bd-kv">${s}</div>`:'<div class="bd-ph">（还没填 TLC 判断）</div>'}case"notes":{const o=String(e.conclusion||e.notes||"").trim();return o?`<div class="bd-text">${a(o)}</div>`:'<div class="bd-ph">（没写结论）</div>'}default:return""}}function H(t,e){const o=e&&e.get||(()=>null),n=(t.refs||[]).map(o).filter(Boolean);if(n.length<2)return'<div class="bd-ph">（对比表至少要两条记录）</div>';const s=n[0],r=t.cols&&t.cols.length?t.cols:["variation","verdict","yield"],l=i=>Number(i.no_yield)===1?"不计":i.yield_pct!=null?`${c(i.yield_pct,1)}%`:"待测",b=(i,m)=>{if(m==="variation"){if(i.id===s.id)return"基准";const h=N(s,i);return h.length?h.length>3?`${h.slice(0,3).join(" · ")} 等 ${h.length} 项`:h.join(" · "):"重复"}return m==="verdict"?String(i.tlc_verdict||"").trim()||"—":m==="yield"?l(i):m==="conds"?[x(i),i.temperature,i.duration].filter(Boolean).join(" · "):String(i[m]||"")},u=r.map(i=>`<th>${i==="variation"?"改了什么":i==="verdict"?"TLC 判断":i==="yield"?"产率":i==="conds"?"条件":a(i)}</th>`).join(""),p=n.map(i=>`<tr><td class="mono">${a(i.code||"")}</td>${r.map(m=>`<td>${a(b(i,m))}</td>`).join("")}</tr>`).join("");return`<table class="bd-tb bd-cmp"><thead><tr><th>编号</th>${u}</tr></thead><tbody>${p}</tbody></table>`}const A=[{key:"ink",label:"墨",v:"#1c1b19"},{key:"accent",label:"强调",v:"#a8471f"},{key:"grey",label:"灰",v:"#8d8b84"},{key:"green",label:"绿",v:"#2f7d4f"},{key:"blue",label:"蓝",v:"#2b6cb0"},{key:"red",label:"红",v:"#b4362c"}];function T(t,e,o){if(!t)return"";const n=String(t.caption||"").trim()?`<div class="bd-cap">${a(t.caption)}</div>`:"";if(t.type==="tlc")return`<img src="/api/files/${t.ref}" alt="">${n}`;if(t.type==="shape"){const r=t.color||A[0].v,l=t.thick?" is-thick":"";return t.shape==="box"?`<div class="bd-shape bd-box${l}" style="--sc:${a(r)}"></div>${n}`:P(t,r)+n}if(t.type==="text")return`<div class="bd-text">${a(t.text)}</div>${n}`;const s=t.type==="scheme"?"react":t.block;return s==="concl"?`<div class="bd-h2">结论</div><div class="bd-text">${a(t.text||"双击写结论")}</div>${n}`:s==="compare"?H(t,o)+n:C(s,e)+n}function K(t,e=z.a4p,o=s=>null,n=null){const s=(t||[]).filter(r=>r&&r.type).map(r=>`<div class="bd-item" style="left:${(r.x/10).toFixed(2)}mm;top:${(r.y/10).toFixed(2)}mm;width:${(r.w/10).toFixed(2)}mm${r.type==="shape"?`;height:${((r.h||400)/10).toFixed(2)}mm`:""}">${T(r,o(r),n)}</div>`);return`<div class="bd-page" style="width:${e.w/10}mm;height:${e.h/10}mm">${s.join("")}</div>`}const U=`
.bd-page { position: relative; overflow: hidden; background: #fff; color: #1c1b19;
  font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; }
.bd-item { position: absolute; }
.bd-item img { display: block; width: 100%; height: auto;
  /* **别让浏览器接管拖拽**：<img> 默认是可以原生的 drag，一按住就起 HTML5 拖放，
     mousemove / mouseup 全被吞掉，照片块就拖不动了（箭头 / 方块没这问题）。 */
  -webkit-user-drag: none; user-select: none; }
.bd-cap { margin-top: 1.4mm; font-size: 7.5pt; line-height: 1.35; color: #4a4740;
  text-align: center; word-break: break-word; }
.bd-text { font-size: 9.5pt; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
/* 画布上的形状：箭头 / 方框。线宽用 mm，跟纸上的字一样是「印刷单位」，
   所以屏幕上缩小看和导出 PDF 一样粗细。 */
/* .bd-body 是 itemHtml 外面那层，不给它高度的话 height:100% 的百分比会落到 auto 上，
   形状就只剩一条线（踩过：方框渲染成 3px 高的细条）。注意别在这段 CSS 里写反引号——
   它整个是 JS 模板字符串。 */
.bd-body { height: 100%; }
.bd-shape { box-sizing: border-box; width: 100%; height: 100%; }
.bd-box { border: 0.45mm solid var(--sc, #1c1b19); border-radius: 1.4mm; }
.bd-box.is-thick { border-width: 0.9mm; }
.bd-arrow-svg { display: block; width: 100%; height: 100%; overflow: visible; }
.bd-arrow { display: flex; align-items: center; }
.bd-arrow.is-l { flex-direction: row-reverse; }
.bd-arrow .ln { flex: 1 1 auto; border-top: 0.55mm solid var(--sc, #1c1b19); }
.bd-arrow .hd { flex: 0 0 auto; width: 0; height: 0;
  border-top: 1.6mm solid transparent; border-bottom: 1.6mm solid transparent; }
.bd-arrow.is-r .hd { border-left: 3mm solid var(--sc, #1c1b19); }
.bd-arrow.is-l .hd { border-right: 3mm solid var(--sc, #1c1b19); }
.bd-arrow.is-thick .ln { border-top-width: 1.1mm; }
.bd-arrow.is-thick .hd { border-top-width: 2.6mm; border-bottom-width: 2.6mm; }
.bd-arrow.is-thick.is-r .hd { border-left-width: 4.4mm; }
.bd-arrow.is-thick.is-l .hd { border-right-width: 4.4mm; }
.bd-h1 { font-family: "Iowan Old Style", Georgia, serif; font-size: 11.5pt; line-height: 1.35; }
.bd-h2 { font-family: "SF Mono", Menlo, monospace; font-size: 7pt; letter-spacing: 0.1em; color: #a09c93;
  margin-bottom: 1.2mm; }
table.bd-cmp { font-size: 7.6pt; }
table.bd-cmp td.mono { font-family: "SF Mono", Menlo, monospace; white-space: nowrap; }
.bd-sub { margin-top: 1mm; font-size: 7.5pt; color: #6d6862; }
.bd-kv { font-size: 8.8pt; line-height: 1.65; color: #1c1b19; }
.bd-kv .k { font-size: 6.8pt; color: #a09c93; margin-right: 1.2mm; }
.bd-kv .sep { color: #c9c6bd; margin: 0 1.6mm; }
.bd-ph { font-size: 8pt; color: #b4b2aa; }
table.bd-tb { width: 100%; border-collapse: collapse; font-size: 7.8pt; }
table.bd-tb th { font-weight: 500; font-size: 6.4pt; letter-spacing: 0.04em; color: #a09c93;
  text-align: left; padding: 0 1.2mm 0.8mm; border-bottom: 0.2mm solid #ddd9d0; white-space: nowrap; }
table.bd-tb td { padding: 0.7mm 1.2mm; border-bottom: 0.2mm solid #f2f0ec; }
table.bd-tb td.n, table.bd-tb th.n { text-align: right; font-family: "SF Mono", Menlo, monospace; }
table.bd-tb td.role { color: #6d6862; font-size: 7.2pt; }
table.bd-tb td.amt { font-weight: 600; }
`;export{J as B,G as M,z as P,A as S,U as a,K as b,R as c,I as d,C as e,T as i,q as m,D as p,E as s,X as u};
