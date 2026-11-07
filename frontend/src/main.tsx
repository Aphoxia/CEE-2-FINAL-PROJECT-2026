import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient, type Session } from '@supabase/supabase-js';
import { formatMoneyInput, toBaht, toSatang } from './money';
import './style.css';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const supabase = url && key ? createClient(url, key, { auth: { flowType: 'pkce' } }) : null;
type Entry = { description: string; amount: string };
type Draft = { documentType: 'receipt' | 'transfer'; payeeName: string; shopName: string; purchaseDate: string; total: string; lineItems: Entry[]; adjustments: Entry[]; scanId?: string };
type Expense = { id: string; shopName: string | null; payeeName: string | null; documentType: string; purchaseDate: string; totalPaidSatang: number; ownerId?: string };
type Listing = { expenses: Expense[]; runningTotalSatang: number; totalCount: number };
const blank = (): Draft => ({ documentType: 'receipt', payeeName: '', shopName: '', purchaseDate: '', total: '', lineItems: [], adjustments: [] });
const entry = (): Entry => ({ description: '', amount: '' });
const errorMessage = (e: unknown) => e instanceof Error ? e.message : 'เกิดข้อผิดพลาด';

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState('');
  const [profiles, setProfiles] = useState<{ user_id: string; display_name: string }[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [departments, setDepartments] = useState<string[]>([]);
  const [myDepartments, setMyDepartments] = useState<string[]>([]);
  const [departmentBusy, setDepartmentBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState('own');
  const [year, setYear] = useState(''); const [month, setMonth] = useState('');
  const [department, setDepartment] = useState(''); const [owner, setOwner] = useState('');
  const [offset, setOffset] = useState(0);
  const [listing, setListing] = useState<Listing | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ shopName: string | null; payeeName: string | null; lineItems: {description:string;amountSatang:number}[] | null; adjustments: {description:string;amountSatang:number}[] | null } | null>(null);
  const [hadBreakdown, setHadBreakdown] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false); });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    setRole(''); setListing(null); setScope('own'); setDraft(blank()); setEditingId(null); setDetail(null); setHadBreakdown(false); setDepartments([]); setMyDepartments([]); setProfiles([]); setDisplayName('');
    if (!session || !supabase) return;
    let active = true;
    const client = supabase;
    async function initialize() {
      const { error: joinError } = await client!.rpc('ensure_member');
      if (!active) return;
      if (joinError) { setError('ไม่สามารถเปิดใช้งานบัญชีได้ กรุณาลองใหม่'); return; }
      const [membership, available, assigned, profileRows] = await Promise.all([
        client!.from('organization_members').select('access_role').eq('user_id', session!.user.id).maybeSingle(),
        client!.from('departments').select('name').order('name'),
        client!.from('user_departments').select('department_name').eq('user_id', session!.user.id),
        client!.from('member_profiles').select('user_id, display_name').order('display_name'),
      ]);
      if (!active) return;
      if (membership.error || !membership.data) { setError('ไม่สามารถตรวจสอบสมาชิกได้'); return; }
      setRole(membership.data.access_role); setError('');
      if (available.error || assigned.error || profileRows.error) { setError('ไม่สามารถโหลดแผนกได้'); return; }
      setProfiles(profileRows.data ?? []);
      setDisplayName(profileRows.data?.find(row => row.user_id === session!.user.id)?.display_name ?? '');
      setDepartments((available.data ?? []).map(row => row.name));
      setMyDepartments((assigned.data ?? []).map(row => row.department_name));
    }
    void initialize();
    return () => { active = false; };
  }, [session?.user.id]);

  async function saveDisplayName(event: React.FormEvent) {
    event.preventDefault();
    if (!supabase || !session) return;
    const name = displayName.trim();
    if (!name || name.length > 100) { setError('ชื่อแสดงผลต้องมีความยาว 1–100 ตัวอักษร'); return; }
    setBusy(true); setError(''); setNotice('');
    const { data, error: updateError } = await supabase.from('member_profiles')
      .update({ display_name: name }).eq('user_id', session.user.id).select('user_id, display_name').single();
    if (updateError || !data) setError('ไม่สามารถบันทึกชื่อได้');
    else { setDisplayName(data.display_name); setProfiles(current => current.map(profile => profile.user_id === data.user_id ? data : profile)); setNotice('บันทึกชื่อแสดงผลแล้ว'); }
    setBusy(false);
  }

  async function toggleDepartment(name: string, checked: boolean) {
    if (!supabase || !session) return;
    setDepartmentBusy(true); setError('');
    const result = checked
      ? await supabase.from('user_departments').insert({ user_id: session.user.id, department_name: name })
      : await supabase.from('user_departments').delete().eq('user_id', session.user.id).eq('department_name', name);
    if (result.error) setError('ไม่สามารถเปลี่ยนแผนกได้ กรุณาลองใหม่');
    else setMyDepartments(current => checked ? [...current, name] : current.filter(item => item !== name));
    setDepartmentBusy(false);
  }

  async function api(path: string, options: RequestInit = {}) {
    if (!session) throw new Error('กรุณาล็อกอินอีกครั้ง');
    const headers = new Headers(options.headers); headers.set('Authorization', `Bearer ${session.access_token}`);
    const response = await fetch(path, { ...options, headers });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const message = body.error === 'duplicate_receipt' ? 'รูปใบเสร็จนี้เคยบันทึกแล้ว' : (body.error ?? 'request_failed');
      throw new Error(`${message} (HTTP ${response.status})`);
    }
    return response.status === 204 ? null : response.json();
  }
  async function load(nextOffset = 0) {
    const params = new URLSearchParams({ scope, limit: '20', offset: String(nextOffset) });
    if (year) params.set('year', year); if (month) params.set('month', month);
    if (scope === 'organization' && department.trim()) params.set('department', department.trim());
    if (scope === 'organization' && owner.trim()) params.set('ownerId', owner.trim());
    try { setError(''); const result = await api(`/api/expenses?${params}`); setListing(result); setOffset(nextOffset); }
    catch (e) { setError(errorMessage(e)); }
  }
  useEffect(() => { if (session && role) void load(); }, [session?.user.id, role]);
  async function scan() {
    if (!file) { setError('กรุณาเลือกรูปใบเสร็จก่อน'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api('/api/scans', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      const r = result.receipt;
      const map = (items: { description: string | null; amountSatang: number | null }[] | null) => (items ?? []).map(i => ({ description: i.description ?? '', amount: toBaht(i.amountSatang) }));
      setDraft({ documentType: r.documentType ?? 'receipt', payeeName: r.payeeName ?? '', shopName: r.shopName ?? '', purchaseDate: r.purchaseDate ?? '', total: toBaht(r.totalPaidSatang), lineItems: map(r.lineItems), adjustments: map(r.adjustments), scanId: result.scanId });
      setEditingId(null); setHadBreakdown(false); setNotice('สแกนแล้ว กรุณาตรวจทุกช่องก่อนบันทึก รายการยอดติดลบอาจอยู่ในส่วนปรับยอด และเอกสารก่อนรับเงินไม่ได้ยืนยันว่ามีการจ่ายเงินจริง');
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setError(''); setNotice('');
    const totalPaidSatang = toSatang(draft.total);
    const convert = (items: Entry[]) => items.map(i => ({ description: i.description.trim(), amountSatang: toSatang(i.amount) }));
    const items = convert(draft.lineItems); const adjustments = convert(draft.adjustments);
    if (totalPaidSatang === null || totalPaidSatang < 0 || items.some(i => !i.description || i.amountSatang === null || i.amountSatang < 0) || adjustments.some(i => !i.description || i.amountSatang === null)) { setError('ตรวจชื่อรายการและจำนวนเงินให้ถูกต้อง (สูงสุด 2 ตำแหน่ง)'); return; }
    if (draft.scanId && draft.documentType === 'receipt' && items.length === 0) { setError('ใบเสร็จที่สแกนต้องมีรายการสินค้าอย่างน้อย 1 รายการ'); return; }
    if (editingId && hadBreakdown && items.length === 0) { setError('รายการที่มีรายละเอียดต้องมีสินค้าอย่างน้อย 1 รายการ'); return; }
    if (items.length && [...items, ...adjustments].reduce((sum, i) => sum + i.amountSatang!, 0) !== totalPaidSatang) { setError('ผลรวมรายการและส่วนปรับยอดต้องเท่ากับยอดจ่ายจริง'); return; }
    if (!draft.shopName.trim() && !draft.payeeName.trim()) { setError('กรุณาระบุชื่อร้านค้าหรือผู้รับเงินอย่างน้อยหนึ่งช่อง'); return; }
    const body: Record<string, unknown> = { documentType: draft.documentType, payeeName: draft.payeeName.trim() || null, shopName: draft.shopName.trim() || null, purchaseDate: draft.purchaseDate, totalPaidSatang };
    if (items.length) { body.lineItems = items; body.adjustments = adjustments; }
    else if (adjustments.length) { setError('เพิ่มรายการสินค้าก่อนเพิ่มส่วนปรับยอด'); return; }
    if (draft.scanId && !editingId) body.scanId = draft.scanId;
    setBusy(true);
    try { await api(editingId ? `/api/expenses/${editingId}` : '/api/expenses', { method: editingId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); setDraft(blank()); setEditingId(null); setFile(null); if (fileInput.current) fileInput.current.value = ''; setNotice('บันทึกรายการแล้ว'); await load(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function edit(id: string) {
    try { const r = await api(`/api/expenses/${id}`); const map = (v: {description:string;amountSatang:number}[] | null) => (v ?? []).map(i => ({ description: i.description, amount: toBaht(i.amountSatang) })); setDraft({ documentType:r.documentType, payeeName:r.payeeName ?? '', shopName:r.shopName ?? '', purchaseDate:r.purchaseDate, total:toBaht(r.totalPaidSatang), lineItems:map(r.lineItems), adjustments:map(r.adjustments) }); setHadBreakdown(!!r.lineItems?.length); setEditingId(id); setNotice('กำลังแก้ไขรายการ'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    catch (e) { setError(errorMessage(e)); }
  }
  async function remove(id: string) { if (!window.confirm('ลบรายการนี้ใช่ไหม?')) return; try { await api(`/api/expenses/${id}`, { method:'DELETE' }); setDetail(null); setNotice('ลบรายการแล้ว'); await load(); } catch (e) { setError(errorMessage(e)); } }
  async function showDetail(id: string) { try { setDetail(await api(`/api/expenses/${id}`)); } catch (e) { setError(errorMessage(e)); } }
  function updateEntry(kind: 'lineItems' | 'adjustments', index: number, field: keyof Entry, value: string) { setDraft(d => ({ ...d, [kind]: d[kind].map((item, i) => i === index ? { ...item, [field]: value } : item) })); }
  const renderEntries = (kind: 'lineItems' | 'adjustments', title: string) => <fieldset><legend>{title}</legend>{draft[kind].map((item, i) => <div className="entry" key={i}><input aria-label={`${title} ชื่อ ${i + 1}`} placeholder="ชื่อรายการ" value={item.description} onChange={e => updateEntry(kind, i, 'description', e.target.value)} /><input aria-label={`${title} จำนวนเงิน ${i + 1}`} inputMode="decimal" placeholder="บาท" value={item.amount} onChange={e => updateEntry(kind, i, 'amount', e.target.value)} onBlur={e => updateEntry(kind, i, 'amount', formatMoneyInput(e.target.value))} /><button type="button" className="secondary" onClick={() => setDraft(d => ({ ...d, [kind]: d[kind].filter((_, n) => n !== i) }))}>ลบ</button></div>)}<button type="button" className="secondary" onClick={() => setDraft(d => ({ ...d, [kind]: [...d[kind], entry()] }))}>+ เพิ่ม{title}</button></fieldset>;

  if (!supabase) return <main><div className="card"><h1>ตั้งค่าโปรเจกต์ก่อนเริ่ม</h1><p>คัดลอก frontend/.env.example เป็น frontend/.env แล้วใส่ Supabase URL และ publishable key</p></div></main>;
  return <main><header><div><p className="eyebrow">CEE PROJECT · TEST UI</p><h1>Receipt Scanner</h1><p>สแกน ตรวจสอบ และจัดการค่าใช้จ่าย</p></div>{session && <button className="secondary" onClick={() => supabase.auth.signOut()}>ออกจากระบบ</button>}</header>
    {error && <p className="alert" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    {loading ? <p>กำลังโหลด...</p> : !session ? <section className="card"><h2>เข้าสู่ระบบ</h2><p>ใช้บัญชี Google ที่เพิ่มเป็น test user แล้ว</p><button onClick={async () => { const { error: e } = await supabase.auth.signInWithOAuth({ provider:'google', options:{ redirectTo: window.location.origin } }); if (e) setError(e.message); }}>เข้าสู่ระบบด้วย Google</button></section> : !role ? <section className="card">กำลังตรวจสอบสิทธิ์สมาชิก หรือบัญชียังไม่ได้รับสิทธิ์</section> : <>
      <div className="identity">{session.user.email} <span className="badge">{role === 'finance_head' ? 'Finance Head' : 'สมาชิกทั่วไป'}</span></div>
      <section className="card"><form onSubmit={saveDisplayName}><label>ชื่อแสดงผล<input value={displayName} maxLength={100} onChange={e => setDisplayName(e.target.value)} /></label><button disabled={busy}>บันทึกชื่อ</button></form><p className="muted">ชื่อซ้ำกันได้ และเปลี่ยนได้ภายหลัง</p></section>
      <section className="card department-card"><h2>แผนกในชมรม</h2><p className="muted">เลือกได้หลายแผนกเพื่อทดลอง แผนกไม่ได้เปลี่ยนสิทธิ์ Finance Head</p><div className="department-options">{departments.map(name => <label key={name}><input type="checkbox" checked={myDepartments.includes(name)} disabled={departmentBusy} onChange={e => toggleDepartment(name, e.target.checked)} />{name}</label>)}</div></section>
      <div className="layout"><section className="card"><h2>เพิ่มค่าใช้จ่าย</h2><p className="muted">สแกนใบเสร็จหรือกรอกเอง · จำนวนเงินเป็นบาท</p><div className="scan"><input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" aria-label="รูปใบเสร็จ" onChange={e => setFile(e.target.files?.[0] ?? null)} /><button type="button" disabled={busy} onClick={scan}>สแกนใบเสร็จ</button></div><form onSubmit={save}><label>ประเภทเอกสาร<select value={draft.documentType} onChange={e => setDraft({ ...draft, documentType:e.target.value as Draft['documentType'] })}><option value="receipt">ใบเสร็จ</option><option value="transfer">สลิปโอนเงิน</option></select></label><label>ร้านค้า<input maxLength={200} value={draft.shopName} onChange={e => setDraft({ ...draft, shopName:e.target.value })} /></label><label>ผู้รับเงิน<input maxLength={200} value={draft.payeeName} onChange={e => setDraft({ ...draft, payeeName:e.target.value })} /></label><p className="muted">ระบุชื่อร้านค้าหรือผู้รับเงินอย่างน้อยหนึ่งช่อง</p><label>วันที่<input required type="date" value={draft.purchaseDate} onChange={e => setDraft({ ...draft, purchaseDate:e.target.value })} /></label><label>ยอดจ่ายจริง (บาท)<input required inputMode="decimal" value={draft.total} onChange={e => setDraft({ ...draft, total:e.target.value })} onBlur={e => setDraft(d => ({ ...d, total:formatMoneyInput(e.target.value) }))} /></label>{renderEntries('lineItems','รายการสินค้า')}{renderEntries('adjustments','ส่วนปรับยอด')}<p className="muted">ส่วนลดใช้ค่าติดลบ เช่น -5.00 · ผลรวมต้องตรงยอดจ่ายจริง</p><div className="actions"><button disabled={busy}>{editingId ? 'บันทึกการแก้ไข' : 'ยืนยันและบันทึก'}</button><button type="button" className="secondary" onClick={() => {setDraft(blank()); setEditingId(null);}}>ล้างแบบฟอร์ม</button></div></form></section>
      <section className="card"><h2>รายการค่าใช้จ่าย</h2><form onSubmit={e => { e.preventDefault(); void load(); }} className="filters">{role === 'finance_head' && <label>ขอบเขต<select value={scope} onChange={e => setScope(e.target.value)}><option value="own">ของฉัน</option><option value="organization">ทั้งองค์กร</option></select></label>}<label>ปี ค.ศ.<input inputMode="numeric" placeholder="2026" value={year} onChange={e => setYear(e.target.value)} /></label><label>เดือน<select value={month} onChange={e => setMonth(e.target.value)}><option value="">ทุกเดือน</option>{Array.from({length:12},(_, i) => <option key={i} value={i+1}>{i+1}</option>)}</select></label>{scope === 'organization' && role === 'finance_head' && <><label>แผนก<input placeholder="เช่น IT" value={department} onChange={e => setDepartment(e.target.value)} /></label><label>ผู้บันทึก<select value={owner} onChange={e => setOwner(e.target.value)}><option value="">ทุกคน</option>{profiles.map(profile => <option key={profile.user_id} value={profile.user_id}>{profile.display_name} · {profile.user_id}</option>)}</select></label></>}<button>ใช้ตัวกรอง</button></form><p className="muted">หากเลือกเดือน ต้องระบุปี · ชื่อแผนกต้องตรงตัวพิมพ์</p>{listing && <><div className="summary"><div><small>ยอดรวมตามตัวกรอง</small><strong>฿{toBaht(listing.runningTotalSatang)}</strong></div><div><small>จำนวนรายการ</small><strong>{listing.totalCount}</strong></div></div>{listing.expenses.length ? <ul className="expenses">{listing.expenses.map(item => <li key={item.id}><div><strong>{item.shopName || item.payeeName}</strong><small>{item.documentType === 'transfer' ? 'สลิปโอนเงิน · ' : 'ใบเสร็จ · '}{item.purchaseDate}{<> · ผู้บันทึก: {profiles.find(profile => profile.user_id === (item.ownerId ?? session.user.id))?.display_name ?? 'ยังไม่ได้ตั้งชื่อ'}{item.ownerId && <> ({item.ownerId.slice(0, 8)})</>}</>}</small></div><div className="expense-actions"><strong>฿{toBaht(item.totalPaidSatang)}</strong><button className="link" onClick={() => showDetail(item.id)}>ดูรายละเอียด</button>{(!item.ownerId || item.ownerId === session.user.id) && <span><button className="link" onClick={() => edit(item.id)}>แก้ไข</button><button className="link danger" onClick={() => remove(item.id)}>ลบ</button></span>}</div></li>)}</ul> : <p className="muted">ยังไม่มีรายการที่ตรงกับตัวกรอง</p>}{detail && <div className="detail"><h3>รายละเอียด · {detail.shopName || detail.payeeName}</h3>{detail.shopName && <p>ร้านค้า: {detail.shopName}</p>}{detail.payeeName && <p>ผู้รับเงิน: {detail.payeeName}</p>}{detail.lineItems?.length ? <ul>{detail.lineItems.map((item, i) => <li key={i}>{item.description}: ฿{toBaht(item.amountSatang)}</li>)}</ul> : <p>ไม่มีรายละเอียดสินค้า</p>}{detail.adjustments?.map((item, i) => <p key={i}>{item.description}: ฿{toBaht(item.amountSatang)}</p>)}<button className="secondary" onClick={() => setDetail(null)}>ปิดรายละเอียด</button></div>}<div className="actions"><button className="secondary" disabled={offset === 0} onClick={() => load(Math.max(0, offset - 20))}>ก่อนหน้า</button><button className="secondary" disabled={offset + 20 >= listing.totalCount} onClick={() => load(offset + 20)}>ถัดไป</button></div></>}</section></div>
    </>}</main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
