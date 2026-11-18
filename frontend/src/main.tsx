import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient, type Session } from '@supabase/supabase-js';
import { clubDepartments, departmentLabel } from './departments';
import { formatMoneyInput, toBaht, toSatang } from './money';
import './style.css';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const supabase = url && key ? createClient(url, key, { auth: { flowType: 'pkce' } }) : null;
type Entry = { description: string; amount: string };
type Draft = { documentType: 'receipt' | 'transfer'; payeeName: string; shopName: string; purchaseDate: string; total: string; lineItems: Entry[]; adjustments: Entry[]; scanId?: string };
type Expense = { id: string; shopName: string | null; payeeName: string | null; documentType: string; purchaseDate: string; totalPaidSatang: number; ownerId?: string };
type Detail = { shopName: string | null; payeeName: string | null; lineItems: {description:string;amountSatang:number}[] | null; adjustments: {description:string;amountSatang:number}[] | null };
type Listing = { expenses: Expense[]; runningTotalSatang: number; totalCount: number };
type ExpenseScope = 'own' | 'organization';
const hasOrganizationAccess = (departments: string[]) =>
  departments.includes('BOARD') || departments.includes('FINANCE');
const blank = (): Draft => ({ documentType: 'receipt', payeeName: '', shopName: '', purchaseDate: '', total: '', lineItems: [], adjustments: [] });
const entry = (): Entry => ({ description: '', amount: '' });
const errorMessage = (e: unknown) => e instanceof Error ? e.message : 'เกิดข้อผิดพลาด';

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = window.localStorage.getItem('receipt-scanner-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch { /* Storage can be unavailable in private browsing. */ }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [memberReady, setMemberReady] = useState(false);
  const [profiles, setProfiles] = useState<{ user_id: string; display_name: string }[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [departments, setDepartments] = useState<string[]>([]);
  const [myDepartments, setMyDepartments] = useState<string[]>([]);
  const selectableDepartments = clubDepartments.filter(([id]) => departments.includes(id));
  const [ownerDepartments, setOwnerDepartments] = useState<{user_id: string; department_name: string}[]>([]);
  const [ownerDepartmentsLoading, setOwnerDepartmentsLoading] = useState(false);
  const [ownerDepartmentsError, setOwnerDepartmentsError] = useState(false);
  const [departmentBusy, setDepartmentBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<ExpenseScope>('own');
  const canViewOrganization = hasOrganizationAccess(myDepartments);
  const [year, setYear] = useState(''); const [month, setMonth] = useState('');
  const [exactDate, setExactDate] = useState('');
  const [dateMode, setDateMode] = useState<'all' | 'year' | 'month' | 'monthYear' | 'date'>('all');
  const [dateOpen, setDateOpen] = useState(false);
  const [department, setDepartment] = useState(''); const [owner, setOwner] = useState('');
  const [offset, setOffset] = useState(0);
  const [listing, setListing] = useState<Listing | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [openDetailId, setOpenDetailId] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, Detail>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({});
  const [hadBreakdown, setHadBreakdown] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const listingRequest = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem('receipt-scanner-theme', theme); }
    catch { /* The selected theme still works for this session without storage. */ }
  }, [theme]);

  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false); });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    listingRequest.current += 1;
    setDepartment('');
    setOwner('');
    setMemberReady(false); setListing(null); setScope('own'); setDraft(blank()); setEditingId(null); setOpenDetailId(null); setDetailCache({}); setDetailLoading({}); setHadBreakdown(false); setDepartments([]); setMyDepartments([]); setProfiles([]); setDisplayName(''); setOwnerDepartments([]); setOwnerDepartmentsError(false); setOwnerDepartmentsLoading(false);
    if (!session || !supabase) return;
    let active = true;
    const client = supabase;
    async function initialize() {
      const { error: joinError } = await client!.rpc('ensure_member');
      if (!active) return;
      if (joinError) { setError('ไม่สามารถเปิดใช้งานบัญชีได้ กรุณาลองใหม่'); return; }
      const [available, assigned, selfProfile] = await Promise.all([
        client!.from('departments').select('name').order('name'),
        client!.from('user_departments').select('department_name').eq('user_id', session!.user.id),
        client!.from('member_profiles').select('user_id, display_name').eq('user_id', session!.user.id).maybeSingle(),
      ]);
      if (!active) return;
      if (available.error || assigned.error || selfProfile.error) {
        setError('ไม่สามารถโหลดโปรไฟล์และแผนกได้');
        return;
      }
      const assignedDepartments = (assigned.data ?? []).map(row => row.department_name);
      setProfiles(selfProfile.data ? [selfProfile.data] : []);
      setDisplayName(selfProfile.data?.display_name ?? '');
      setDepartments((available.data ?? []).map(row => row.name));
      setMyDepartments(assignedDepartments);
      setScope(hasOrganizationAccess(assignedDepartments) ? 'organization' : 'own');
      setError('');
      setMemberReady(true);
    }
    void initialize();
    return () => { active = false; };
  }, [session?.user.id]);

  useEffect(() => {
    if (!supabase || !session || !listing) return;
    const ownerIds = [...new Set(listing.expenses.map(item => item.ownerId).filter((id): id is string => !!id && id !== session.user.id))];
    if (!ownerIds.length) { setOwnerDepartments([]); setOwnerDepartmentsLoading(false); setOwnerDepartmentsError(false); return; }
    let active = true;
    setOwnerDepartments([]); setOwnerDepartmentsLoading(true); setOwnerDepartmentsError(false);
    void supabase.from('user_departments').select('user_id, department_name').in('user_id', ownerIds)
      .then(({ data, error: fetchError }) => {
        if (!active) return;
        setOwnerDepartments(data ?? []); setOwnerDepartmentsError(!!fetchError); setOwnerDepartmentsLoading(false);
      });
    return () => { active = false; };
  }, [listing, session?.user.id]);

  useEffect(() => {
    if (!supabase || !session || !memberReady || !canViewOrganization) return;
    let active = true;
    void supabase.from('member_profiles').select('user_id, display_name').order('display_name')
      .then(({ data, error: profilesError }) => {
        if (!active) return;
        if (profilesError) setError('ไม่สามารถโหลดชื่อผู้บันทึกได้');
        else setProfiles(data ?? []);
      });
    return () => { active = false; };
  }, [session?.user.id, memberReady, canViewOrganization]);

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
    else {
      const nextDepartments = checked ? [...myDepartments, name] : myDepartments.filter(item => item !== name);
      const nextAccess = hasOrganizationAccess(nextDepartments);
      setMyDepartments(nextDepartments);
      if (nextAccess !== canViewOrganization) {
        if (!nextAccess) {
          setOwner('');
          setDepartment('');
          setProfiles(current => current.filter(profile => profile.user_id === session.user.id));
        }
        setDateMode('all');
        changeScope(nextAccess ? 'organization' : 'own', 'all');
      }
    }
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
  async function load(nextOffset = 0, requestedScope = scope, requestedDateMode = dateMode) {
    if ((requestedDateMode === 'date' && !exactDate) || ((requestedDateMode === 'month' || requestedDateMode === 'monthYear') && !month) || ((requestedDateMode === 'year' || requestedDateMode === 'monthYear') && (!year || Number(year) < 1 || Number(year) > 9998 || !/^\d+$/.test(year)))) {
      setError('กรุณาเลือกวันที่ เดือน หรือปีให้ครบก่อนใช้ตัวกรอง'); setDateOpen(true); return;
    }
    setDateOpen(false);
    const params = new URLSearchParams({ scope: requestedScope, limit: '20', offset: String(nextOffset) });
    if (requestedDateMode === 'year' || requestedDateMode === 'monthYear') params.set('year', year);
    if (requestedDateMode === 'month' || requestedDateMode === 'monthYear') params.set('month', month);
    if (requestedDateMode === 'date') { const [y, m, d] = exactDate.split('-'); params.set('year', y ?? ''); params.set('month', m ?? ''); params.set('day', d ?? ''); }
    if (requestedScope === 'organization' && department) params.set('department', department);
    if (requestedScope === 'organization' && owner) params.set('ownerId', owner);

    const requestId = ++listingRequest.current;
    setError('');
    try {
      const result = await api(`/api/expenses?${params}`);
      if (requestId !== listingRequest.current) return;
      setListing(result);
      setOffset(nextOffset);
      setOpenDetailId(null);
      setDetailCache({});
    } catch (e) {
      if (requestId === listingRequest.current) setError(errorMessage(e));
    }
  }
  useEffect(() => { if (session && memberReady) void load(0, scope, 'all'); }, [session?.user.id, memberReady]);

  function changeScope(nextScope: ExpenseScope, nextDateMode = dateMode) {
    listingRequest.current += 1;
    setScope(nextScope);
    setListing(null);
    setOpenDetailId(null);
    setDetailCache({});
    void load(0, nextScope, nextDateMode);
  }

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
  async function remove(id: string) { if (!window.confirm('ลบรายการนี้ใช่ไหม?')) return; try { await api(`/api/expenses/${id}`, { method:'DELETE' }); setOpenDetailId(null); setDetailCache({}); setNotice('ลบรายการแล้ว'); await load(); } catch (e) { setError(errorMessage(e)); } }
  async function showDetail(id: string) {
    if (openDetailId === id) { setOpenDetailId(null); return; }
    setOpenDetailId(id); setError('');
    if (detailCache[id] || detailLoading[id]) return;
    setDetailLoading(current => ({ ...current, [id]: true }));
    try { const result: Detail = await api(`/api/expenses/${id}`); setDetailCache(current => ({ ...current, [id]: result })); }
    catch (e) { setError(errorMessage(e)); setOpenDetailId(current => current === id ? null : current); }
    finally { setDetailLoading(current => ({ ...current, [id]: false })); }
  }
  function updateEntry(kind: 'lineItems' | 'adjustments', index: number, field: keyof Entry, value: string) { setDraft(d => ({ ...d, [kind]: d[kind].map((item, i) => i === index ? { ...item, [field]: value } : item) })); }
  const renderEntries = (kind: 'lineItems' | 'adjustments', title: string) => <fieldset><legend>{title}</legend>{draft[kind].map((item, i) => <div className="entry" key={i}><input aria-label={`${title} ชื่อ ${i + 1}`} placeholder="ชื่อรายการ" value={item.description} onChange={e => updateEntry(kind, i, 'description', e.target.value)} /><input aria-label={`${title} จำนวนเงิน ${i + 1}`} inputMode="decimal" placeholder="บาท" value={item.amount} onChange={e => updateEntry(kind, i, 'amount', e.target.value)} onBlur={e => updateEntry(kind, i, 'amount', formatMoneyInput(e.target.value))} /><button type="button" className="secondary" onClick={() => setDraft(d => ({ ...d, [kind]: d[kind].filter((_, n) => n !== i) }))}>ลบ</button></div>)}<button type="button" className="secondary" onClick={() => setDraft(d => ({ ...d, [kind]: [...d[kind], entry()] }))}>+ เพิ่ม{title}</button></fieldset>;

  if (!supabase) return <main className="app-shell"><section className="card setup-card"><span className="brand-mark">R</span><p className="eyebrow">ตั้งค่าระบบ</p><h1>เชื่อมต่อฐานข้อมูลก่อนเริ่ม</h1><p className="muted">คัดลอก <code>frontend/.env.example</code> เป็น <code>frontend/.env</code> แล้วใส่ Supabase URL และ publishable key</p></section></main>;
  return <main className="app-shell"><header className="topbar"><div className="brand-lockup"><span className="brand-mark" aria-hidden="true">R</span><div><p className="brand-name">Receipt Scanner</p></div></div><div className="header-actions"><button type="button" className="secondary theme-toggle" aria-pressed={theme === 'dark'} aria-label={theme === 'dark' ? 'ปิดโหมดมืด' : 'เปิดโหมดมืด'} onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀️ โหมดสว่าง' : '🌙 โหมดมืด'}</button>{session && <button className="secondary" onClick={() => supabase.auth.signOut()}>ออกจากระบบ</button>}</div></header>
    {(error || notice) && <div className="feedback-stack">{error && <p className="alert" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}</div>}
    {loading ? <section className="card loading-card"><span className="spinner" aria-hidden="true" /><p>กำลังโหลดข้อมูลของคุณ…</p></section> : !session ? <section className="auth-layout"><section className="card auth-card"><span className="auth-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M6 3.75h12a1.5 1.5 0 0 1 1.5 1.5v15l-2.5-1.5-2.5 1.5-2.5-1.5-2.5 1.5-2.5-1.5-2.5 1.5v-15a1.5 1.5 0 0 1 1.5-1.5Z" /><path d="M9 8h6M9 12h6M9 16h3" /></svg></span><h1>เข้าสู่ระบบ</h1><button className="google-button" onClick={async () => { const { error: e } = await supabase.auth.signInWithOAuth({ provider:'google', options:{ redirectTo: window.location.origin } }); if (e) setError(e.message); }}><span className="google-g" aria-hidden="true">G</span>เข้าสู่ระบบด้วย Google<span className="button-arrow" aria-hidden="true">→</span></button></section></section> : !memberReady ? <section className="card loading-card"><span className="spinner" aria-hidden="true" /><p>กำลังตรวจสอบสิทธิ์สมาชิก…</p></section> : <>
      <section className="dashboard-heading"><div><p className="eyebrow">ภาพรวมค่าใช้จ่าย</p><h1>สวัสดี, {displayName || 'สมาชิก'}</h1><p className="muted">จัดการใบเสร็จและตรวจสอบรายการล่าสุดของคุณ</p></div><div className="identity"><span className="account-email">{session.user.email}</span><span className="badge">{canViewOrganization ? 'ดูได้ทั้งองค์กร' : 'สมาชิกทั่วไป'}</span></div></section>
      <div className="account-grid"><section className="card profile-card"><div className="section-heading"><div><p className="eyebrow">บัญชีของคุณ</p><h2>โปรไฟล์</h2></div><span className="section-icon" aria-hidden="true">◉</span></div><form className="profile-form" onSubmit={saveDisplayName}><label>ชื่อแสดงผล<input value={displayName} maxLength={100} onChange={e => setDisplayName(e.target.value)} /></label><button disabled={busy}>บันทึกชื่อ</button></form><p className="muted">ชื่อแสดงผลซ้ำกันได้ และเปลี่ยนภายหลัง</p></section>
      <section className="card department-card"><div className="section-heading"><div><p className="eyebrow">จัดหมวดหมู่</p><h2>แผนกในชมรม</h2></div><span className="section-icon" aria-hidden="true">⌘</span></div><p className="muted">เลือกได้หลายแผนก · เลือก Board หรือ Finance เพื่ออ่านบิลทั้งองค์กร</p><div className="department-options">{myDepartments.includes('MEMBER_RELATIONS') && <label><input type="checkbox" checked disabled={departmentBusy} onChange={() => toggleDepartment('MEMBER_RELATIONS', false)} /><span>{departmentLabel('MEMBER_RELATIONS')}</span></label>}{selectableDepartments.map(([id, label]) => <label key={id}><input type="checkbox" checked={myDepartments.includes(id)} disabled={departmentBusy} onChange={e => toggleDepartment(id, e.target.checked)} /><span>{label}</span></label>)}</div></section></div>
      <div className="layout"><section className="card expense-form-card"><div className="section-heading"><div><p className="eyebrow">บันทึกรายการ</p><h2>{editingId ? 'แก้ไขค่าใช้จ่าย' : 'เพิ่มค่าใช้จ่าย'}</h2></div><span className="section-icon" aria-hidden="true">＋</span></div><p className="muted">สแกนใบเสร็จหรือกรอกเอง · จำนวนเงินเป็นบาท</p><div className="scan"><input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" aria-label="รูปใบเสร็จ" onChange={e => setFile(e.target.files?.[0] ?? null)} /><button type="button" disabled={busy} onClick={scan}>สแกนใบเสร็จ</button></div>{file && <p className="selected-file">เลือกรูปแล้ว: {file.name}</p>}<form className="expense-form" onSubmit={save}><label>ประเภทเอกสาร<select value={draft.documentType} onChange={e => setDraft({ ...draft, documentType:e.target.value as Draft['documentType'] })}><option value="receipt">ใบเสร็จ</option><option value="transfer">สลิปโอนเงิน</option></select></label><label>ร้านค้า<input maxLength={200} value={draft.shopName} onChange={e => setDraft({ ...draft, shopName:e.target.value })} /></label><label>ผู้รับเงิน<input maxLength={200} value={draft.payeeName} onChange={e => setDraft({ ...draft, payeeName:e.target.value })} /></label><p className="muted">ระบุชื่อร้านค้าหรือผู้รับเงินอย่างน้อยหนึ่งช่อง</p><label>วันที่<input required type="date" value={draft.purchaseDate} onChange={e => setDraft({ ...draft, purchaseDate:e.target.value })} /></label><label>ยอดจ่ายจริง (บาท)<input required inputMode="decimal" value={draft.total} onChange={e => setDraft({ ...draft, total:e.target.value })} onBlur={e => setDraft(d => ({ ...d, total:formatMoneyInput(e.target.value) }))} /></label>{renderEntries('lineItems','รายการสินค้า')}{renderEntries('adjustments','ส่วนปรับยอด')}<p className="muted">ส่วนลดใช้ค่าติดลบ เช่น -5.00 · ผลรวมต้องตรงยอดจ่ายจริง</p><div className="actions"><button disabled={busy}>{editingId ? 'บันทึกการแก้ไข' : 'ยืนยันและบันทึก'}</button><button type="button" className="secondary" onClick={() => {setDraft(blank()); setEditingId(null);}}>ล้างแบบฟอร์ม</button></div></form></section>
      <section className="card expense-list-card"><div className="section-heading list-heading"><div><p className="eyebrow">รายการบันทึก</p><h2>ค่าใช้จ่าย</h2></div>{listing && <span className="count-pill">{listing.totalCount} รายการ</span>}</div><p className="muted">รายการล่าสุดอยู่ด้านบน · แผนกเป็นข้อมูลปัจจุบันของผู้บันทึก · เลื่อนตารางในแนวนอนได้เมื่อใช้จอเล็ก</p>
      <form onSubmit={e => { e.preventDefault(); void load(); }} className="filters">
        {canViewOrganization && (
          <label>ขอบเขต
            <select value={scope} onChange={event => {
              const nextScope = event.currentTarget.value === 'organization' ? 'organization' : 'own';
              changeScope(nextScope);
            }}>
              <option value="own">ของฉัน</option>
              <option value="organization">ทั้งองค์กร</option>
            </select>
          </label>
        )}<div className="date-filter"><span className="filter-label">วันที่</span><button type="button" className="date-trigger" aria-expanded={dateOpen} aria-controls="date-filter-panel" onClick={() => setDateOpen(!dateOpen)}><span>📅 {dateMode === 'all' ? 'ทุกวันที่' : dateMode === 'date' ? (exactDate || 'เลือกวันที่') : dateMode === 'year' ? (year ? `ปี ${year}` : 'เลือกปี') : dateMode === 'month' ? (month ? `เดือน ${month} · ทุกปี` : 'เลือกเดือน') : (month && year ? `เดือน ${month} / ${year}` : 'เลือกเดือนและปี')}</span><span aria-hidden="true">▾</span></button>{dateOpen && <div className="date-panel" id="date-filter-panel"><p className="date-panel-title">เลือกช่วงเวลา</p><div className="date-mode-options" role="group" aria-label="รูปแบบวันที่">{([['all','ทั้งหมด'],['date','วันที่'],['month','เดือน'],['monthYear','เดือน / ปี'],['year','ปี']] as const).map(([mode, label]) => <button key={mode} type="button" aria-pressed={dateMode === mode} className={dateMode === mode ? 'date-mode selected' : 'date-mode'} onClick={() => setDateMode(mode)}>{label}</button>)}</div>{dateMode === 'date' && <label>เลือกวันที่<input type="date" value={exactDate} onChange={e => setExactDate(e.target.value)} /></label>}{(dateMode === 'month' || dateMode === 'monthYear') && <label>เดือน<select value={month} onChange={e => setMonth(e.target.value)}><option value="">เลือกเดือน</option>{Array.from({length:12},(_, i) => <option key={i} value={i+1}>{new Intl.DateTimeFormat('th-TH', {month:'long'}).format(new Date(2024,i,1))}</option>)}</select></label>}{(dateMode === 'year' || dateMode === 'monthYear') && <label>ปี ค.ศ.<input type="number" min="1" max="9998" placeholder="2026" value={year} onChange={e => setYear(e.target.value)} /></label>}<div className="date-panel-actions"><button type="button" className="secondary" onClick={() => {setDateMode('all'); setDateOpen(false);}}>ล้างวันที่</button><button type="button" onClick={() => setDateOpen(false)}>เสร็จ</button></div></div>}</div>{scope === 'organization' && canViewOrganization && <><label>แผนก<select value={department} onChange={e => setDepartment(e.target.value)}><option value="">ทุกแผนก</option>{selectableDepartments.map(([id, label]) => <option key={id} value={id}>{label}</option>)}{departments.includes('MEMBER_RELATIONS') && <option value="MEMBER_RELATIONS">{departmentLabel('MEMBER_RELATIONS')}</option>}</select></label><label>ผู้บันทึก<select value={owner} onChange={e => setOwner(e.target.value)}><option value="">ทุกคน</option>{profiles.map(profile => <option key={profile.user_id} value={profile.user_id}>{profile.display_name} · {profile.user_id}</option>)}</select></label></>}<button>ใช้ตัวกรอง</button></form>{listing && <><div className="summary"><div><small>ยอดรวมตามตัวกรอง</small><strong>฿{toBaht(listing.runningTotalSatang)}</strong></div><div><small>จำนวนรายการ</small><strong>{listing.totalCount}</strong></div></div>{listing.expenses.length ? <div className="table-scroll" role="region" aria-label="ตารางรายการค่าใช้จ่าย" tabIndex={0}><table className="expense-table"><thead><tr><th scope="col">วันที่</th><th scope="col">ร้านค้า / ผู้รับเงิน</th><th scope="col">ประเภท</th><th scope="col">ผู้บันทึก</th><th scope="col">แผนก</th><th scope="col" className="amount">ยอดจ่าย</th><th scope="col">จัดการ</th></tr></thead><tbody>{listing.expenses.map(item => <React.Fragment key={item.id}><tr><td className="date-cell">{item.purchaseDate}</td><td className="counterparty">{item.shopName || item.payeeName}</td><td><span className="type-tag">{item.documentType === 'transfer' ? 'สลิปโอนเงิน' : 'ใบเสร็จ'}</span></td><td>{profiles.find(profile => profile.user_id === (item.ownerId ?? session.user.id))?.display_name ?? 'ยังไม่ได้ตั้งชื่อ'}{item.ownerId && <small className="owner-id">ID: {item.ownerId.slice(0, 8)}</small>}</td><td>{!item.ownerId || item.ownerId === session.user.id ? (myDepartments.length ? myDepartments.map(departmentLabel).join(', ') : 'ไม่ได้เลือก') : ownerDepartmentsLoading ? 'กำลังโหลด...' : ownerDepartmentsError ? 'โหลดไม่ได้' : (ownerDepartments.filter(row => row.user_id === item.ownerId).map(row => departmentLabel(row.department_name)).join(', ') || 'ไม่ได้เลือก')}</td><td className="amount">฿{toBaht(item.totalPaidSatang)}</td><td><div className="table-actions"><button type="button" className="link" aria-expanded={openDetailId === item.id} aria-controls={`detail-${item.id}`} onClick={() => showDetail(item.id)}>{openDetailId === item.id ? '▴ ซ่อน' : '▾ รายละเอียด'}</button>{(!item.ownerId || item.ownerId === session.user.id) && <><button type="button" className="link" onClick={() => edit(item.id)}>แก้ไข</button><button type="button" className="link danger" onClick={() => remove(item.id)}>ลบ</button></>}</div></td></tr>{openDetailId === item.id && <tr id={`detail-${item.id}`}><td colSpan={7} className="detail-row"><div className="inline-detail">{detailLoading[item.id] && !detailCache[item.id] ? <p>กำลังโหลดรายละเอียด...</p> : detailCache[item.id] && <><strong>รายการย่อย</strong>{detailCache[item.id].shopName && <p>ร้านค้า: {detailCache[item.id].shopName}</p>}{detailCache[item.id].payeeName && <p>ผู้รับเงิน: {detailCache[item.id].payeeName}</p>}{detailCache[item.id].lineItems?.length ? <ul>{detailCache[item.id].lineItems!.map((line, i) => <li key={i}><span>{line.description}</span><span>฿{toBaht(line.amountSatang)}</span></li>)}</ul> : <p>ไม่มีรายละเอียดสินค้า</p>}{detailCache[item.id].adjustments?.map((line, i) => <p key={i}>{line.description}: ฿{toBaht(line.amountSatang)}</p>)}</>}</div></td></tr>}</React.Fragment>)}</tbody></table></div> : <p className="empty-state">ยังไม่มีรายการที่ตรงกับตัวกรอง</p>}<div className="actions"><button className="secondary" disabled={offset === 0} onClick={() => load(Math.max(0, offset - 20))}>ก่อนหน้า</button><button className="secondary" disabled={offset + 20 >= listing.totalCount} onClick={() => load(offset + 20)}>ถัดไป</button></div></>}</section></div>
    </>}</main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
