import React, { useEffect, useMemo, useRef, useState } from "react";
// Usa apenas ícones que já faziam parte da versão estável anterior do painel.
// Isso evita que um named export ausente em uma versão do lucide derrube todo o bundle na inicialização.
import { Check, ChevronLeft, Clock, Loader2, Plus, Search, TrendingUp, X } from "lucide-react";

const money = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const monthISO = () => todayISO().slice(0, 7);
const addMonths = (iso, n) => {
  // Nunca constrói primeiro uma data impossível (ex.: 31/02), porque o JS a empurra
  // para março antes de conseguirmos corrigir. Calcula ano/mês alvo e só depois o dia.
  const [yRaw, mRaw, dRaw] = String(iso || todayISO()).split("-").map(Number);
  const y = Number.isFinite(yRaw) ? yRaw : new Date().getFullYear();
  const m = Number.isFinite(mRaw) ? mRaw : 1;
  const d = Number.isFinite(dRaw) ? dRaw : 1;
  const baseMonth = (m - 1) + Number(n || 0);
  const targetYear = y + Math.floor(baseMonth / 12);
  const targetMonthIndex = ((baseMonth % 12) + 12) % 12;
  const last = new Date(targetYear, targetMonthIndex + 1, 0, 12, 0, 0).getDate();
  const day = Math.min(Math.max(1, d), last);
  return `${targetYear}-${String(targetMonthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};
const dateBR = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = String(iso).split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
};
const n = (v) => Number(v) || 0;

function derive(data) {
  const sales = Array.isArray(data?.sales) ? data.sales : [];
  const installments = Array.isArray(data?.installments) ? data.installments : [];
  const payments = Array.isArray(data?.payments) ? data.payments : [];
  const byInstPay = {};
  for (const p of payments) {
    if (p?.voided) continue;
    byInstPay[p.installmentId] ||= [];
    byInstPay[p.installmentId].push(p);
  }
  const saleMap = Object.fromEntries(sales.map((s) => [s.id, s]));
  const today = todayISO();
  const enrichedInstallments = installments.map((inst) => {
    const pays = byInstPay[inst.id] || [];
    const paid = pays.reduce((sum, p) => sum + n(p.amount), 0);
    const total = n(inst.amount);
    const remaining = Math.max(0, Math.round((total - paid) * 100) / 100);
    const sale = saleMap[inst.saleId];
    let status = "scheduled";
    if (sale?.status === "cancelled") status = paid >= total - 0.005 ? "paid" : "cancelled";
    else if (remaining <= 0.005) status = "paid";
    else if (inst.dueDate && inst.dueDate < today) status = "overdue";
    else if (inst.dueDate === today) status = "receivable";
    else status = "scheduled";
    return { ...inst, payments: pays, paid, remaining, status, sale };
  });
  const bySaleInst = {};
  for (const inst of enrichedInstallments) {
    bySaleInst[inst.saleId] ||= [];
    bySaleInst[inst.saleId].push(inst);
  }
  const enrichedSales = sales.map((sale) => {
    const parts = (bySaleInst[sale.id] || []).sort((a, b) => n(a.number) - n(b.number));
    const paid = parts.reduce((sum, x) => sum + x.paid, 0);
    const open = sale.status === "cancelled" ? 0 : parts.reduce((sum, x) => sum + x.remaining, 0);
    return { ...sale, installments: parts, paid, open };
  });
  return { sales: enrichedSales, installments: enrichedInstallments, payments, audit: data?.audit || [] };
}

function statusLabel(status) {
  if (status === "paid") return ["Paga", "#4f9d69", "#1c2a22"];
  if (status === "overdue") return ["Vencida", "#e0736a", "#2a1c1c"];
  if (status === "cancelled") return ["Cancelada", "#8b95a6", "#20252e"];
  if (status === "receivable") return ["A receber", "#e0a458", "#2a2418"];
  return ["Programada", "#7aa2c9", "#1e2733"];
}

function StatusPill({ status }) {
  const [label, color, bg] = statusLabel(status);
  return <span className="text-[10px] font-semibold px-2 py-1 rounded-full" style={{ color, background: bg, border: `1px solid ${color}55` }}>{label}</span>;
}

function SummaryCard({ label, value, accent = "#f8fafc", sub }) {
  return (
    <div className="rounded-xl px-4 py-3 min-w-0" style={{ background: "#1c222c", border: "1px solid #2c3444" }}>
      <div className="mono text-lg font-bold truncate" style={{ color: accent }}>{value}</div>
      <div className="text-[10px] text-slate-500 mt-0.5">{label}</div>
      {sub && <div className="text-[10px] text-slate-600 mt-1">{sub}</div>}
    </div>
  );
}

function makeInstallments(total, qty, firstDate) {
  const cents = Math.round(n(total) * 100);
  const q = Math.max(1, Math.min(24, Math.floor(n(qty) || 1)));
  const base = Math.floor(cents / q);
  let rest = cents - base * q;
  return Array.from({ length: q }, (_, i) => {
    const amount = base + (rest > 0 ? 1 : 0);
    if (rest > 0) rest--;
    return { id: "", amount: (amount / 100).toFixed(2), dueDate: addMonths(firstDate || todayISO(), i) };
  });
}

function SaleForm({ sellers, editing, onSave, onCancel }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [qty, setQty] = useState(1);
  const [firstDue, setFirstDue] = useState(todayISO());
  const initializedForRef = useRef(null);

  // Inicializa o formulário apenas quando ele é aberto para uma venda diferente.
  // O polling do painel troca o array de vendedores/dados a cada atualização; ele
  // NÃO pode apagar o que o administrador ainda está digitando.
  useEffect(() => {
    const key = editing?.id ? `edit:${editing.id}` : "new";
    if (initializedForRef.current === key) return;
    initializedForRef.current = key;
    if (editing) {
      const editingComputed = editing.commissionType === "percent" ? (n(editing.saleValue) * n(editing.commissionRate) / 100) : n(editing.commissionValue);
      const inferredManual = editing.commissionType === "percent" && Math.abs(n(editing.commissionValue) - editingComputed) > 0.005;
      setForm({
        id: editing.id, version: n(editing.version), seller: editing.seller || sellers[0] || "", client: editing.client || "", phone: editing.phone || "",
        saleDate: editing.saleDate || todayISO(), saleValue: String(editing.saleValue || ""), commissionType: editing.commissionType || "fixed",
        commissionRate: String(editing.commissionRate || ""), commissionValue: String(editing.commissionValue || ""),
        commissionManual: editing.commissionManual === true || inferredManual, notes: editing.notes || "",
        installments: (editing.installments || []).map((x) => ({ id: x.id, amount: String(x.amount), dueDate: x.dueDate })),
      });
      setQty(Math.max(1, editing.installments?.length || 1));
      setFirstDue(editing.installments?.[0]?.dueDate || todayISO());
    } else {
      setForm({ id: "", version: 0, seller: sellers[0] || "", client: "", phone: "", saleDate: todayISO(), saleValue: "", commissionType: "fixed", commissionRate: "", commissionValue: "", commissionManual: false, notes: "", installments: [{ id: "", amount: "", dueDate: todayISO() }] });
      setQty(1); setFirstDue(todayISO());
    }
  }, [editing?.id]);

  // Se o formulário novo abriu antes da lista de vendedores terminar de carregar,
  // preenche somente o campo vazio; nunca reinicializa os demais campos.
  const sellersKey = (sellers || []).join("\u0001");
  useEffect(() => {
    if (!editing?.id && form && !form.seller && sellers?.[0]) {
      setForm((old) => old && !old.seller ? { ...old, seller: sellers[0] } : old);
    }
  }, [sellersKey, editing?.id, form?.seller]);

  if (!form) return null;
  const computed = form.commissionType === "percent" ? (n(form.saleValue) * n(form.commissionRate) / 100) : n(form.commissionValue);
  // Percentual usa o cálculo automático por padrão. O valor final só vira exceção
  // quando o administrador marca isso ao preencher manualmente o campo opcional.
  const commissionValue = form.commissionType === "percent"
    ? (form.commissionManual ? n(form.commissionValue) : computed)
    : n(form.commissionValue);
  const update = (k, v) => setForm((old) => ({ ...old, [k]: v }));
  const generate = () => setForm((old) => ({ ...old, installments: makeInstallments(commissionValue, qty, firstDue) }));
  const payloadFor = (force = false) => {
    const installments = form.installments.map((x) => ({ ...x, amount: n(x.amount), dueDate: x.dueDate }));
    // Facilita a comissão simples: se existe uma única parcela ainda vazia,
    // ela assume automaticamente o valor total da comissão no momento de salvar.
    if (installments.length === 1 && n(installments[0].amount) <= 0 && commissionValue > 0) installments[0].amount = commissionValue;
    return { ...form, commissionValue, commissionManual: form.commissionType === "percent" && !!form.commissionManual, force, installments };
  };
  const submit = async () => {
    if (saving) return;
    setSaving(true); setError("");
    try {
      try {
        await onSave(payloadFor(false));
      } catch (e) {
        const msg = String(e?.message || e);
        if (e?.status === 409 && /semelhante/i.test(msg) && window.confirm("Já existe uma venda semelhante cadastrada. Deseja cadastrar mesmo assim?")) {
          await onSave(payloadFor(true));
        } else {
          throw e;
        }
      }
      onCancel();
    } catch (e) {
      setError(String(e?.message || e));
    } finally { setSaving(false); }
  };

  return (
    <div className="rounded-2xl p-4 mb-5" style={{ background: "#191d25", border: "1px solid #3a465a" }}>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <div className="text-sm font-semibold text-slate-100">{editing ? "Editar venda/comissão" : "Cadastrar nova venda"}</div>
          <div className="text-[11px] text-slate-500">Venda → comissão → parcelas → pagamento</div>
        </div>
        <button onClick={onCancel} className="text-slate-500 hover:text-slate-200"><X size={18}/></button>
      </div>
      {error && <div className="mb-3 rounded-lg px-3 py-2 text-xs text-[#f0a89f]" style={{ background: "#2a1c1c", border: "1px solid #7f3d38" }}>{error}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="text-[11px] text-slate-500">Vendedor<select value={form.seller} onChange={(e)=>update("seller",e.target.value)} className="mt-1 w-full rounded-lg px-3 py-2 text-sm text-slate-100" style={{background:"#10141a",border:"1px solid #2c3444"}}>{sellers.map(v=><option key={v}>{v}</option>)}</select></label>
        <label className="text-[11px] text-slate-500">Cliente<input value={form.client} onChange={(e)=>update("client",e.target.value)} className="mt-1 w-full rounded-lg px-3 py-2 text-sm" style={{background:"#10141a",border:"1px solid #2c3444"}} /></label>
        <label className="text-[11px] text-slate-500">Telefone (opcional)<input value={form.phone} onChange={(e)=>update("phone",e.target.value)} className="mt-1 w-full rounded-lg px-3 py-2 text-sm" style={{background:"#10141a",border:"1px solid #2c3444"}} /></label>
        <label className="text-[11px] text-slate-500">Data da venda<input type="date" value={form.saleDate} onChange={(e)=>update("saleDate",e.target.value)} className="mt-1 w-full rounded-lg px-3 py-2 text-sm" style={{background:"#10141a",border:"1px solid #2c3444"}} /></label>
        <label className="text-[11px] text-slate-500">Valor da venda<input type="number" step="0.01" value={form.saleValue} onChange={(e)=>update("saleValue",e.target.value)} className="mt-1 w-full rounded-lg px-3 py-2 text-sm" style={{background:"#10141a",border:"1px solid #2c3444"}} /></label>
        <label className="text-[11px] text-slate-500">Tipo de comissão<select value={form.commissionType} onChange={(e)=>setForm(old=>({...old,commissionType:e.target.value,commissionManual:e.target.value==="percent"?false:old.commissionManual}))} className="mt-1 w-full rounded-lg px-3 py-2 text-sm" style={{background:"#10141a",border:"1px solid #2c3444"}}><option value="fixed">Valor fixo</option><option value="percent">Percentual</option></select></label>
        {form.commissionType === "percent" ? <>
          <label className="text-[11px] text-slate-500">Percentual (%)<input type="number" step="0.01" value={form.commissionRate} onChange={(e)=>update("commissionRate",e.target.value)} className="mt-1 w-full rounded-lg px-3 py-2 text-sm" style={{background:"#10141a",border:"1px solid #2c3444"}} /></label>
          <label className="text-[11px] text-slate-500">Comissão final (opcional)<input type="number" step="0.01" value={form.commissionManual ? form.commissionValue : ""} onChange={(e)=>setForm(old=>({...old,commissionValue:e.target.value,commissionManual:e.target.value!==""}))} placeholder={`Automática: ${money(computed)}`} className="mt-1 w-full rounded-lg px-3 py-2 text-sm" style={{background:"#10141a",border:"1px solid #2c3444"}} /><span className="block mt-1 text-[9px] text-slate-600">Deixe vazio para usar o percentual calculado. Preencha apenas quando quiser uma exceção manual.</span></label>
        </> : <label className="text-[11px] text-slate-500">Comissão total<input type="number" step="0.01" value={form.commissionValue} onChange={(e)=>update("commissionValue",e.target.value)} className="mt-1 w-full rounded-lg px-3 py-2 text-sm" style={{background:"#10141a",border:"1px solid #2c3444"}} /></label>}
        <div className="rounded-lg px-3 py-2" style={{background:"#10141a",border:"1px solid #2c3444"}}><div className="text-[10px] text-slate-500">Comissão final</div><div className="mono font-bold text-[#e0a458] mt-1">{money(commissionValue)}</div>{form.commissionType === "percent" && form.commissionManual && <div className="text-[9px] text-[#e0a458] mt-1">Exceção manual · cálculo original {money(computed)}</div>}</div>
      </div>
      <label className="block text-[11px] text-slate-500 mt-3">Observações<textarea value={form.notes} onChange={(e)=>update("notes",e.target.value)} rows={2} className="mt-1 w-full rounded-lg px-3 py-2 text-sm" style={{background:"#10141a",border:"1px solid #2c3444"}} /></label>
      <div className="mt-4 rounded-xl p-3" style={{background:"#14181f",border:"1px solid #2c3444"}}>
        <div className="flex items-end gap-2 flex-wrap mb-3">
          <label className="text-[11px] text-slate-500">Parcelas<input type="number" min="1" max="24" value={qty} onChange={(e)=>setQty(e.target.value)} className="mt-1 block w-24 rounded-lg px-2 py-2" style={{background:"#10141a",border:"1px solid #2c3444"}} /></label>
          <label className="text-[11px] text-slate-500">Primeiro vencimento<input type="date" value={firstDue} onChange={(e)=>setFirstDue(e.target.value)} className="mt-1 block rounded-lg px-2 py-2" style={{background:"#10141a",border:"1px solid #2c3444"}} /></label>
          <button onClick={generate} type="button" className="px-3 py-2 rounded-lg text-xs font-semibold text-[#14181f]" style={{background:"#e0a458"}}>Gerar parcelas</button>
          <span className="text-[10px] text-slate-600">As datas e valores podem ser ajustados individualmente antes de salvar.</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          {form.installments.map((part, i)=><div key={part.id || i} className="flex gap-2 items-end rounded-lg p-2" style={{background:"#10141a",border:"1px solid #232a36"}}><label className="text-[10px] text-slate-500 flex-1">Parcela {i+1}<input type="number" step="0.01" value={part.amount} onChange={(e)=>setForm(o=>({...o,installments:o.installments.map((x,j)=>j===i?{...x,amount:e.target.value}:x)}))} className="mt-1 w-full bg-transparent text-sm" /></label><label className="text-[10px] text-slate-500 flex-1">Vencimento<input type="date" value={part.dueDate} onChange={(e)=>setForm(o=>({...o,installments:o.installments.map((x,j)=>j===i?{...x,dueDate:e.target.value}:x)}))} className="mt-1 w-full bg-transparent text-sm" /></label></div>)}
        </div>
        <div className="text-[11px] mt-2 text-slate-500">Soma das parcelas: <span className="mono text-slate-200">{money(form.installments.reduce((s,x)=>s+n(x.amount),0))}</span> · comissão: <span className="mono text-slate-200">{money(commissionValue)}</span></div>
      </div>
      {editing?.paid > 0 && <div className="mt-3 text-[11px] text-[#e0a458]">Esta comissão já possui pagamento. Por segurança, vendedor, valores e estrutura de parcelas ficam travados pelo servidor; dados descritivos ainda podem ser corrigidos.</div>}
      <div className="flex justify-end gap-2 mt-4"><button onClick={onCancel} className="px-3 py-2 rounded-lg text-xs text-slate-400" style={{border:"1px solid #2c3444"}}>Cancelar</button><button onClick={submit} disabled={saving} className="px-4 py-2 rounded-lg text-xs font-bold text-[#14181f] flex items-center gap-1.5" style={{background:"#e0a458",opacity:saving?.7:1}}>{saving?<Loader2 size={13} className="animate-spin"/>:<Check size={13}/>} Salvar venda</button></div>
    </div>
  );
}

function PaymentEditor({ inst, onPay, onClose }) {
  const [amount, setAmount] = useState(inst.remaining.toFixed(2));
  const [paidAt, setPaidAt] = useState(todayISO());
  const [method, setMethod] = useState("Pix");
  const [notes, setNotes] = useState("");
  const [saving,setSaving]=useState(false); const [error,setError]=useState("");
  // Mantém o MESMO id enquanto este formulário estiver aberto. Se o Redis gravar
  // e a resposta HTTP se perder, tanto o retry automático quanto o clique manual
  // seguinte usam a mesma chave idempotente e não criam um segundo pagamento.
  const paymentRequestIdRef = useRef(globalThis.crypto?.randomUUID?.() || `pay-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const submit=async()=>{if(saving)return;setSaving(true);setError("");try{await onPay({installmentId:inst.id,amount:n(amount),paidAt,method,notes,requestId:paymentRequestIdRef.current});onClose();}catch(e){setError(String(e?.message||e));}finally{setSaving(false)}};
  return <div className="mt-2 rounded-lg p-3" style={{background:"#10141a",border:"1px solid #3a465a"}}>{error&&<div className="text-[11px] text-[#f0a89f] mb-2">{error}</div>}<div className="grid grid-cols-2 md:grid-cols-4 gap-2"><input type="number" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} className="rounded-lg px-2 py-2 text-xs" style={{background:"#191d25",border:"1px solid #2c3444"}}/><input type="date" value={paidAt} onChange={e=>setPaidAt(e.target.value)} className="rounded-lg px-2 py-2 text-xs" style={{background:"#191d25",border:"1px solid #2c3444"}}/><input value={method} onChange={e=>setMethod(e.target.value)} placeholder="Forma: Pix" className="rounded-lg px-2 py-2 text-xs" style={{background:"#191d25",border:"1px solid #2c3444"}}/><input value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Observação" className="rounded-lg px-2 py-2 text-xs" style={{background:"#191d25",border:"1px solid #2c3444"}}/></div><div className="flex justify-end gap-2 mt-2"><button onClick={onClose} className="text-xs text-slate-500">fechar</button><button onClick={submit} disabled={saving} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[#14181f]" style={{background:"#4f9d69"}}>{saving?"salvando…":"Confirmar pagamento"}</button></div></div>;
}

function CommissionCalendar({ installments, month, setMonth, selectedDay, setSelectedDay }) {
  const [year, mon] = month.split("-").map(Number);
  const first = new Date(year, mon-1, 1, 12);
  const offset=(first.getDay()+6)%7;
  const days=new Date(year,mon,0).getDate();
  const byDay={};
  for(const x of installments){ if(!x.dueDate?.startsWith(month))continue; byDay[x.dueDate]||=[];byDay[x.dueDate].push(x); }
  const cells=[...Array(offset).fill(null),...Array.from({length:days},(_,i)=>i+1)];
  return <div><div className="flex items-center justify-between gap-2 mb-3"><button onClick={()=>setMonth(addMonths(`${month}-01`,-1).slice(0,7))} className="w-8 h-8 rounded-lg" style={{border:"1px solid #2c3444"}}>‹</button><input type="month" value={month} onChange={e=>setMonth(e.target.value)} className="rounded-lg px-2 py-1.5 text-xs" style={{background:"#10141a",border:"1px solid #2c3444"}}/><button onClick={()=>setMonth(addMonths(`${month}-01`,1).slice(0,7))} className="w-8 h-8 rounded-lg" style={{border:"1px solid #2c3444"}}>›</button></div><div className="grid grid-cols-7 gap-1 text-center mb-1">{["SEG","TER","QUA","QUI","SEX","SÁB","DOM"].map(x=><div key={x} className="text-[8px] text-slate-600">{x}</div>)}</div><div className="grid grid-cols-7 gap-1">{cells.map((day,i)=>{if(!day)return <div key={`b${i}`} />;const iso=`${month}-${String(day).padStart(2,"0")}`;const items=byDay[iso]||[];const value=items.reduce((s,x)=>s+x.remaining,0);const overdue=items.some(x=>x.status==="overdue");const paid=items.length>0&&items.every(x=>x.status==="paid");return <button key={iso} onClick={()=>setSelectedDay(iso)} className="min-h-[58px] rounded-lg p-1 text-left" style={{background:selectedDay===iso?"#252d3a":overdue?"#2a1c1c":paid?"#1c2a22":"#14181f",border:`1px solid ${selectedDay===iso?"#e0a458":"#2c3444"}`}}><div className="text-[9px] text-slate-500">{day}</div>{items.length>0&&<><div className="mono text-[9px] text-slate-200 mt-1 truncate">{money(value)}</div><div className="text-[8px] text-slate-600">{items.length} com.</div></>}</button>})}</div></div>;
}

export function AdminCommissionsView({ data, sellers, onBack, onSaveSale, onPay, onCorrectPayment, onCancelSale, onRefresh, loading }) {
  const d=useMemo(()=>derive(data),[data]);
  const [showForm,setShowForm]=useState(false); const [editing,setEditing]=useState(null); const [selectedSale,setSelectedSale]=useState(null); const [payInst,setPayInst]=useState(null);
  const [filterSeller,setFilterSeller]=useState("__all"); const [query,setQuery]=useState(""); const [period,setPeriod]=useState("month"); const [customStart,setCustomStart]=useState(""); const [customEnd,setCustomEnd]=useState(""); const [status,setStatus]=useState("__all");
  const [calMonth,setCalMonth]=useState(monthISO()); const [selectedDay,setSelectedDay]=useState(todayISO());
  const today=todayISO(), month=today.slice(0,7), year=today.slice(0,4);
  const paymentsThisMonth=d.payments.filter(p=>p.paidAt?.startsWith(month)).reduce((s,p)=>s+n(p.amount),0);
  const active=d.sales.filter(s=>s.status!=="cancelled");
  const soldMonth=active.filter(s=>s.saleDate?.startsWith(month)).reduce((s,x)=>s+n(x.saleValue),0);
  const soldYear=active.filter(s=>s.saleDate?.startsWith(year)).reduce((s,x)=>s+n(x.saleValue),0);
  const soldAll=active.reduce((s,x)=>s+n(x.saleValue),0);
  const generatedMonth=active.filter(s=>s.saleDate?.startsWith(month)).reduce((s,x)=>s+n(x.commissionValue),0);
  const open=d.installments.filter(x=>x.sale?.status!=="cancelled").reduce((s,x)=>s+x.remaining,0);
  const overdue=d.installments.filter(x=>x.status==="overdue").reduce((s,x)=>s+x.remaining,0);
  const inDays=(days)=>{const end=new Date();end.setHours(12,0,0,0);end.setDate(end.getDate()+days);const e=todayISOFrom(end);return d.installments.filter(x=>x.sale?.status!=="cancelled"&&x.status!=="paid"&&x.dueDate>=today&&x.dueDate<=e).reduce((s,x)=>s+x.remaining,0)};
  function todayISOFrom(dt){return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`}
  const range=useMemo(()=>{if(period==="today")return[today,today];if(period==="week"){const d=new Date();d.setHours(12,0,0,0);d.setDate(d.getDate()-6);return[todayISOFrom(d),today]}if(period==="month")return[`${month}-01`,`${month}-31`];if(period==="prevmonth"){const p=addMonths(`${month}-01`,-1).slice(0,7);return[`${p}-01`,`${p}-31`]}if(period==="year")return[`${year}-01-01`,`${year}-12-31`];if(period==="custom")return[customStart||"0000-00-00",customEnd||"9999-99-99"];return["0000-00-00","9999-99-99"]},[period,today,month,year,customStart,customEnd]);
  const filtered=d.sales.filter(s=>{if(filterSeller!=="__all"&&s.seller!==filterSeller)return false;if(query&&!`${s.client} ${s.phone} ${s.seller} ${s.saleDate}`.toLowerCase().includes(query.toLowerCase()))return false;if(s.saleDate<range[0]||s.saleDate>range[1])return false;if(status==="cancelled"&&s.status!=="cancelled")return false;if(status==="open"&&!(s.status!=="cancelled"&&s.open>0))return false;if(status==="paid"&&!(s.status!=="cancelled"&&s.open<=.005))return false;if(status==="overdue"&&!s.installments.some(x=>x.status==="overdue"))return false;if(status==="scheduled"&&!s.installments.some(x=>x.status==="scheduled"||x.status==="receivable"))return false;return true}).sort((a,b)=>String(b.saleDate).localeCompare(String(a.saleDate)));
  const sellerUniverse=useMemo(()=>Array.from(new Set([...(sellers||[]),...d.sales.map(x=>x.seller).filter(Boolean)])).sort((a,b)=>a.localeCompare(b,"pt-BR")),[sellers,d.sales]);
  const ranking=useMemo(()=>sellerUniverse.map(seller=>{const rows=active.filter(x=>x.seller===seller);return{seller,count:rows.length,sold:rows.reduce((a,x)=>a+n(x.saleValue),0),commission:rows.reduce((a,x)=>a+n(x.commissionValue),0),paid:rows.reduce((a,x)=>a+x.paid,0),open:rows.reduce((a,x)=>a+x.open,0)}}).sort((a,b)=>b.sold-a.sold),[sellerUniverse,active]);
  const rankingCount=useMemo(()=>[...ranking].sort((a,b)=>b.count-a.count),[ranking]);
  const rankingCommission=useMemo(()=>[...ranking].sort((a,b)=>b.commission-a.commission),[ranking]);
  const dayItems=d.installments.filter(x=>x.dueDate===selectedDay);
  const currentSelected=d.sales.find(x=>x.id===selectedSale?.id)||null;
  const edit=(sale)=>{setEditing(sale);setShowForm(true);window.scrollTo({top:0,behavior:"smooth"})};
  return <div>
    <div className="flex items-center justify-between gap-3 flex-wrap mb-5"><div><button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-400 mb-2"><ChevronLeft size={15}/> voltar</button><div className="flex items-center gap-2"><TrendingUp size={22} className="text-[#e0a458]"/><h2 className="text-xl font-semibold">Controle de Comissões</h2></div><div className="text-[11px] text-slate-500 mt-1">Vendas, parcelas, pagamentos, calendário e auditoria financeira.</div></div><div className="flex gap-2"><button onClick={onRefresh} className="px-3 py-2 rounded-lg text-xs" style={{border:"1px solid #2c3444"}}>{loading?"atualizando…":"Atualizar"}</button><button onClick={()=>{setEditing(null);setShowForm(true)}} className="px-3 py-2 rounded-lg text-xs font-bold text-[#14181f] flex items-center gap-1" style={{background:"#e0a458"}}><Plus size={13}/> Nova venda</button></div></div>
    {showForm&&<SaleForm sellers={sellers} editing={editing} onSave={onSaveSale} onCancel={()=>{setShowForm(false);setEditing(null)}}/>}
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 mb-5"><SummaryCard label="Vendido no mês" value={money(soldMonth)} accent="#4f9d69"/><SummaryCard label="Vendido no ano" value={money(soldYear)}/><SummaryCard label="Total histórico vendido" value={money(soldAll)}/><SummaryCard label="Comissões geradas no mês" value={money(generatedMonth)} accent="#e0a458"/><SummaryCard label="Comissões pagas no mês" value={money(paymentsThisMonth)} accent="#4f9d69"/><SummaryCard label="Comissões em aberto" value={money(open)} accent="#e0a458"/><SummaryCard label="Comissões vencidas" value={money(overdue)} accent={overdue>0?"#e0736a":"#8b95a6"}/><SummaryCard label="A vencer em 7 dias" value={money(inDays(7))}/><SummaryCard label="A vencer em 30 dias" value={money(inDays(30))}/><SummaryCard label="Vendas cadastradas" value={String(active.length)}/></div>
    <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_.8fr] gap-4 mb-5"><div className="rounded-2xl p-4" style={{background:"#191d25",border:"1px solid #232a36"}}><div className="flex items-center gap-2 mb-3"><TrendingUp size={14} className="text-[#e0a458]"/><div className="text-xs uppercase tracking-wider text-slate-500">Ranking de vendedores</div></div><div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3"><div className="rounded-lg p-2" style={{background:"#10141a"}}><div className="text-[9px] uppercase text-slate-600">Maior valor vendido</div>{ranking.slice(0,3).map((r,i)=><div key={r.seller} className="text-[10px] mt-1 flex justify-between"><span>{i+1}. {r.seller}</span><span className="mono">{money(r.sold)}</span></div>)}</div><div className="rounded-lg p-2" style={{background:"#10141a"}}><div className="text-[9px] uppercase text-slate-600">Maior nº de vendas</div>{rankingCount.slice(0,3).map((r,i)=><div key={r.seller} className="text-[10px] mt-1 flex justify-between"><span>{i+1}. {r.seller}</span><span className="mono">{r.count}</span></div>)}</div><div className="rounded-lg p-2" style={{background:"#10141a"}}><div className="text-[9px] uppercase text-slate-600">Maior comissão gerada</div>{rankingCommission.slice(0,3).map((r,i)=><div key={r.seller} className="text-[10px] mt-1 flex justify-between"><span>{i+1}. {r.seller}</span><span className="mono">{money(r.commission)}</span></div>)}</div></div><div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-left text-slate-600"><th className="pb-2">Vendedor</th><th>Vendas</th><th>Valor vendido</th><th>Comissão</th><th>Pago</th><th>Aberto</th></tr></thead><tbody>{ranking.map((r,i)=><tr key={r.seller} className="border-t" style={{borderColor:"#232a36"}}><td className="py-2 font-semibold text-slate-200">{i+1}. {r.seller}</td><td className="mono">{r.count}</td><td className="mono">{money(r.sold)}</td><td className="mono">{money(r.commission)}</td><td className="mono text-[#4f9d69]">{money(r.paid)}</td><td className="mono text-[#e0a458]">{money(r.open)}</td></tr>)}</tbody></table></div></div><div className="rounded-2xl p-4" style={{background:"#191d25",border:"1px solid #232a36"}}><div className="text-xs uppercase tracking-wider text-slate-500 mb-3">Previsão financeira</div>{[7,15,30,60].map(days=><div key={days} className="flex justify-between py-2 border-b last:border-0" style={{borderColor:"#232a36"}}><span className="text-sm text-slate-400">Próximos {days} dias</span><span className="mono font-semibold text-slate-100">{money(inDays(days))}</span></div>)}</div></div>
    <div className="grid grid-cols-1 xl:grid-cols-[.8fr_1.2fr] gap-4 mb-5"><div className="rounded-2xl p-4" style={{background:"#191d25",border:"1px solid #232a36"}}><div className="flex items-center gap-2 mb-3"><Clock size={14}/><div className="text-xs uppercase tracking-wider text-slate-500">Calendário de comissões</div></div><CommissionCalendar installments={d.installments} month={calMonth} setMonth={setCalMonth} selectedDay={selectedDay} setSelectedDay={setSelectedDay}/>{dayItems.length>0&&<div className="mt-3 space-y-2">{dayItems.map(x=><div key={x.id} className="rounded-lg px-3 py-2 text-xs" style={{background:"#10141a",border:"1px solid #2c3444"}}><div className="flex justify-between"><span className="font-semibold text-slate-200">{x.sale?.seller} · {x.sale?.client}</span><StatusPill status={x.status}/></div><div className="mt-1 text-slate-500">Parcela {x.number} · {money(x.amount)} · saldo {money(x.remaining)}</div></div>)}</div>}</div><div className="rounded-2xl p-4" style={{background:"#191d25",border:"1px solid #232a36"}}><div className="text-xs uppercase tracking-wider text-slate-500 mb-3">Vendas e comissões</div><div className="flex flex-wrap gap-2 mb-3"><select value={filterSeller} onChange={e=>setFilterSeller(e.target.value)} className="rounded-lg px-2 py-2 text-xs" style={{background:"#10141a",border:"1px solid #2c3444"}}><option value="__all">Todos vendedores</option>{sellerUniverse.map(v=><option key={v}>{v}</option>)}</select><select value={period} onChange={e=>setPeriod(e.target.value)} className="rounded-lg px-2 py-2 text-xs" style={{background:"#10141a",border:"1px solid #2c3444"}}><option value="today">Hoje</option><option value="week">Esta semana</option><option value="month">Este mês</option><option value="prevmonth">Mês anterior</option><option value="year">Este ano</option><option value="all">Todo período</option><option value="custom">Período personalizado</option></select><select value={status} onChange={e=>setStatus(e.target.value)} className="rounded-lg px-2 py-2 text-xs" style={{background:"#10141a",border:"1px solid #2c3444"}}><option value="__all">Todos status</option><option value="open">Em aberto</option><option value="paid">Quitadas</option><option value="overdue">Vencidas</option><option value="scheduled">A receber / programadas</option><option value="cancelled">Canceladas</option></select><div className="flex items-center gap-1 rounded-lg px-2" style={{background:"#10141a",border:"1px solid #2c3444"}}><Search size={12} className="text-slate-600"/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="cliente, telefone, vendedor" className="bg-transparent text-xs py-2 min-w-[170px]"/></div>{period==="custom"&&<><input type="date" value={customStart} onChange={e=>setCustomStart(e.target.value)} className="rounded-lg px-2 text-xs" style={{background:"#10141a",border:"1px solid #2c3444"}}/><input type="date" value={customEnd} onChange={e=>setCustomEnd(e.target.value)} className="rounded-lg px-2 text-xs" style={{background:"#10141a",border:"1px solid #2c3444"}}/></>}</div><div className="space-y-2 max-h-[560px] overflow-y-auto pr-1">{filtered.length===0?<div className="text-center text-slate-600 py-8 text-sm">Nenhuma venda nesse filtro.</div>:filtered.map(s=><div key={s.id} className="rounded-xl p-3" style={{background:"#14181f",border:"1px solid #2c3444"}}><div className="flex justify-between gap-2"><div><div className="font-semibold text-slate-100">{s.client}</div><div className="text-[11px] text-slate-500">{s.seller} · {dateBR(s.saleDate)} {s.phone?`· ${s.phone}`:""}</div></div><div className="text-right"><div className="mono text-sm text-slate-100">{money(s.saleValue)}</div>{s.status==="cancelled"?<StatusPill status="cancelled"/>:<div className="text-[10px] text-slate-500">comissão {money(s.commissionValue)}</div>}</div></div><div className="flex gap-2 flex-wrap mt-2"><button onClick={()=>setSelectedSale(s)} className="px-2 py-1 rounded text-[10px] text-slate-300" style={{border:"1px solid #2c3444"}}>Detalhes</button><button onClick={()=>edit(s)} className="px-2 py-1 rounded text-[10px] text-slate-300 flex items-center gap-1" style={{border:"1px solid #2c3444"}}><TrendingUp size={10}/> Editar</button>{s.status!=="cancelled"&&<button onClick={async()=>{const reason=window.prompt("Motivo do cancelamento (opcional):","");if(reason===null)return;if(window.confirm("Confirmar cancelamento? O histórico e pagamentos já realizados serão preservados."))await onCancelSale(s.id,reason)}} className="px-2 py-1 rounded text-[10px] text-[#e0736a]" style={{border:"1px solid #5b3232"}}>Cancelar</button>}<span className="ml-auto text-[10px] text-slate-500">Pago {money(s.paid)} · aberto {money(s.open)}</span></div></div>)}</div></div></div>
    {currentSelected&&<div className="rounded-2xl p-4 mb-5" style={{background:"#191d25",border:"1px solid #3a465a"}}><div className="flex justify-between"><div><div className="text-sm font-semibold">{currentSelected.client}</div><div className="text-[11px] text-slate-500">{currentSelected.seller} · venda {money(currentSelected.saleValue)} · comissão {money(currentSelected.commissionValue)}</div></div><button onClick={()=>{setSelectedSale(null);setPayInst(null)}}><X size={18} className="text-slate-500"/></button></div><div className="grid grid-cols-1 lg:grid-cols-2 gap-2 mt-3">{currentSelected.installments.map(inst=><div key={inst.id} className="rounded-xl p-3" style={{background:"#10141a",border:"1px solid #2c3444"}}><div className="flex justify-between"><div><div className="text-xs font-semibold">Parcela {inst.number} · {money(inst.amount)}</div><div className="text-[10px] text-slate-500">vence {dateBR(inst.dueDate)} · pago {money(inst.paid)} · saldo {money(inst.remaining)}</div></div><StatusPill status={inst.status}/></div>{inst.status!=="paid"&&inst.status!=="cancelled"&&<button onClick={()=>setPayInst(payInst===inst.id?null:inst.id)} className="mt-2 px-2 py-1.5 rounded-lg text-[10px] font-semibold text-[#14181f]" style={{background:"#4f9d69"}}>Marcar pagamento</button>}{payInst===inst.id&&<PaymentEditor inst={inst} onPay={onPay} onClose={()=>setPayInst(null)}/>} {inst.payments.length>0&&<div className="mt-2 space-y-1">{inst.payments.map(p=><div key={p.id} className="flex justify-between items-center text-[10px] text-slate-500"><span>{dateBR(p.paidAt)} · {money(p.amount)} · {p.method||"—"}</span><button onClick={async()=>{const amount=window.prompt("Valor corrigido:",String(p.amount));if(amount===null)return;const paidAt=window.prompt("Data (AAAA-MM-DD):",p.paidAt);if(paidAt===null)return;const method=window.prompt("Forma de pagamento:",p.method||"");if(method===null)return;await onCorrectPayment({paymentId:p.id,amount:n(amount),paidAt,method,notes:p.notes||""})}} className="text-[#e0a458]">corrigir</button></div>)}</div>}</div>)}</div></div>}
    <div className="rounded-2xl p-4" style={{background:"#191d25",border:"1px solid #232a36"}}><div className="flex items-center gap-2 mb-3"><Clock size={14}/><div className="text-xs uppercase tracking-wider text-slate-500">Histórico de auditoria</div></div><div className="space-y-1 max-h-52 overflow-y-auto">{d.audit.length===0?<div className="text-xs text-slate-600">Nenhuma alteração financeira registrada ainda.</div>:d.audit.slice(0,100).map(ev=><div key={ev.id} className="text-[10px] text-slate-500 border-b py-1.5" style={{borderColor:"#232a36"}}><span className="mono text-slate-400">{new Date(ev.ts).toLocaleString("pt-BR")}</span> · {ev.action} · {ev.entityType} {ev.note?`· ${ev.note}`:""}</div>)}</div></div>
  </div>;
}

export function SellerCommissionsView({ data, onBack, loading, onRefresh }) {
  const d=useMemo(()=>derive(data),[data]); const seller=data?.seller||d.sales[0]?.seller||"Vendedor"; const [calMonth,setCalMonth]=useState(monthISO()); const [selectedDay,setSelectedDay]=useState(todayISO());
  const today=todayISO(), month=today.slice(0,7), year=today.slice(0,4); const active=d.sales.filter(s=>s.status!=="cancelled"); const soldMonth=active.filter(s=>s.saleDate?.startsWith(month)).reduce((a,x)=>a+n(x.saleValue),0); const soldYear=active.filter(s=>s.saleDate?.startsWith(year)).reduce((a,x)=>a+n(x.saleValue),0); const soldAll=active.reduce((a,x)=>a+n(x.saleValue),0); const commMonth=active.filter(s=>s.saleDate?.startsWith(month)).reduce((a,x)=>a+n(x.commissionValue),0); const received=d.payments.reduce((a,x)=>a+n(x.amount),0); const open=d.installments.filter(x=>x.sale?.status!=="cancelled").reduce((a,x)=>a+x.remaining,0); const next=d.installments.filter(x=>x.sale?.status!=="cancelled"&&x.status!=="paid"&&x.dueDate>=today).sort((a,b)=>a.dueDate.localeCompare(b.dueDate))[0]; const dayItems=d.installments.filter(x=>x.dueDate===selectedDay);
  return <div><div className="flex items-center justify-between gap-3 flex-wrap mb-5"><div><button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-400 mb-2"><ChevronLeft size={15}/> voltar ao estado</button><div className="flex items-center gap-2"><TrendingUp size={21} className="text-[#e0a458]"/><h2 className="text-xl font-semibold">Minhas Comissões</h2></div><div className="text-sm text-[#e0a458] font-semibold mt-1">{seller}</div></div><button onClick={onRefresh} className="px-3 py-2 rounded-lg text-xs" style={{border:"1px solid #2c3444"}}>{loading?"atualizando…":"Atualizar"}</button></div><div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5"><SummaryCard label="Vendido este mês" value={money(soldMonth)} accent="#4f9d69"/><SummaryCard label="Vendido este ano" value={money(soldYear)}/><SummaryCard label="Total vendido" value={money(soldAll)}/><SummaryCard label="Comissão gerada no mês" value={money(commMonth)} accent="#e0a458"/><SummaryCard label="Já recebido" value={money(received)} accent="#4f9d69"/><SummaryCard label="Tenho a receber" value={money(open)} accent="#e0a458" sub={next?`Próximo: ${dateBR(next.dueDate)} · ${money(next.remaining)}`:"Nenhum pagamento futuro"}/></div><div className="grid grid-cols-1 lg:grid-cols-[.8fr_1.2fr] gap-4"><div className="rounded-2xl p-4" style={{background:"#191d25",border:"1px solid #232a36"}}><div className="text-xs uppercase tracking-wider text-slate-500 mb-3">Meu calendário de pagamentos</div><CommissionCalendar installments={d.installments} month={calMonth} setMonth={setCalMonth} selectedDay={selectedDay} setSelectedDay={setSelectedDay}/>{dayItems.length>0&&<div className="mt-3 space-y-2">{dayItems.map(x=><div key={x.id} className="rounded-lg p-2" style={{background:"#10141a",border:"1px solid #2c3444"}}><div className="flex justify-between"><span className="text-xs font-semibold">{x.sale?.client}</span><StatusPill status={x.status}/></div><div className="text-[10px] text-slate-500 mt-1">Parcela {x.number} · {money(x.amount)} · saldo {money(x.remaining)}</div></div>)}</div>}</div><div className="rounded-2xl p-4" style={{background:"#191d25",border:"1px solid #232a36"}}><div className="text-xs uppercase tracking-wider text-slate-500 mb-3">Minhas vendas e comissões</div><div className="space-y-2 max-h-[620px] overflow-y-auto">{d.sales.length===0?<div className="text-center text-sm text-slate-600 py-10">Ainda não há comissões cadastradas para você.</div>:d.sales.sort((a,b)=>String(b.saleDate).localeCompare(String(a.saleDate))).map(s=><div key={s.id} className="rounded-xl p-3" style={{background:"#14181f",border:"1px solid #2c3444"}}><div className="flex justify-between gap-2"><div><div className="font-semibold text-slate-100">{s.client}</div><div className="text-[10px] text-slate-500">Venda {dateBR(s.saleDate)} · {money(s.saleValue)}</div></div><div className="text-right"><div className="mono text-sm text-[#e0a458]">{money(s.commissionValue)}</div><div className="text-[9px] text-slate-500">comissão</div></div></div><div className="mt-2 space-y-1">{s.installments.map(x=><div key={x.id} className="flex justify-between items-center text-[10px] rounded-lg px-2 py-1.5" style={{background:"#10141a"}}><span>Parcela {x.number} · {dateBR(x.dueDate)} · {money(x.amount)}</span><StatusPill status={x.status}/></div>)}</div><div className="text-[10px] text-slate-500 mt-2">Recebido {money(s.paid)} · a receber {money(s.open)}</div></div>)}</div></div></div></div>;
}
