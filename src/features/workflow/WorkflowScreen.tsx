import React, { useMemo, useState } from 'react';
import {
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { importLegacyInterventionOS, type LegacyImportResult } from '../../workflow/legacyImport';
import { workflowReducer, type WorkflowAction } from '../../workflow/reducer';
import {
  selectCaseDetail,
  selectOpenTasks,
  selectOutstandingBalanceCents,
  selectPipelineCounts,
  selectRevenue,
  selectTodaysAppointments,
} from '../../workflow/selectors';
import type {
  CaseKind,
  CaseDocumentReference,
  CaseStatus,
  Participant,
  PaymentStatus,
  WorkflowAppointment,
  WorkflowCase,
  WorkflowState,
  WorkflowTask,
} from '../../workflow/types';
import { Badge, Button, Card, ChoiceField, COLORS, Divider, Empty, Field, Row, Section } from './ui';
import {
  canonicalIso,
  displayInstant,
  isDateOnly,
  localDateStamp,
  money,
  optional,
  parseMoneyToCents,
  validIanaTimeZone,
  workflowId,
} from './utils';

export interface WorkflowReferralLink { id: string; clientLabel: string; partnerId?: string }
export interface WorkflowReferralMatchLink { id: string; clientLabel: string; assignedPartnerId?: string; referralId?: string }
export interface WorkflowPartnerLink { id: string; name: string; organization?: string }

export interface WorkflowScreenProps {
  state: WorkflowState;
  onChange(next: WorkflowState): void;
  referrals: readonly WorkflowReferralLink[];
  referralMatches: readonly WorkflowReferralMatchLink[];
  partners: readonly WorkflowPartnerLink[];
  onRequestCalendarSync?: (appointment: WorkflowAppointment) => Promise<void>;
  onRequestContactSync?: (participant: Participant) => Promise<void>;
  onRequestDocumentPick?: (caseId: string) => Promise<CaseDocumentReference | undefined>;
  onRequestDocumentOpen?: (document: CaseDocumentReference) => Promise<void>;
  onRequestDocumentRemove?: (document: CaseDocumentReference) => Promise<void>;
  onRequestBackupExport?: () => Promise<void>;
  onRequestBackupRestore?: () => Promise<void>;
}

type ScreenTab = 'overview' | 'cases' | 'schedule' | 'tasks' | 'revenue' | 'settings';
type CaseFilter = CaseKind | 'archived';
const TABS: { value: ScreenTab; label: string }[] = [
  { value: 'overview', label: 'Overview' }, { value: 'cases', label: 'Cases' },
  { value: 'schedule', label: 'Schedule' }, { value: 'tasks', label: 'Tasks' },
  { value: 'revenue', label: 'Revenue' }, { value: 'settings', label: 'Settings' },
];
const CASE_STATUSES: CaseStatus[] = ['new', 'engaged', 'preparing', 'scheduled', 'completed', 'closed'];
const STATUS_CHOICES = CASE_STATUSES.map((value) => ({ value, label: titleCase(value) }));
const CHECKLIST = [
  ['contractSent', 'Contract sent'], ['contractSigned', 'Contract signed'],
  ['paymentReceived', 'Payment received'], ['prepCallCompleted', 'Prep call completed'],
  ['treatmentSelected', 'Treatment selected'], ['interventionDateSet', 'Intervention date set'],
  ['interventionCompleted', 'Intervention completed'],
] as const;

function titleCase(value: string): string { return value.replace(/(^|[-_ ])\w/g, (match) => match.toUpperCase()).replace(/[-_]/g, ' '); }
function nowIso(): string { return new Date().toISOString(); }
function confirm(title: string, message: string, action: () => void): void {
  Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: 'Confirm', style: 'destructive', onPress: action }]);
}
function caseName(state: WorkflowState, caseId?: string): string {
  return caseId ? state.cases[caseId]?.name ?? 'Unknown case' : 'General';
}

export default function WorkflowScreen(props: WorkflowScreenProps) {
  const { state, onChange } = props;
  const [tab, setTab] = useState<ScreenTab>('overview');
  const [selectedCaseId, setSelectedCaseId] = useState<string>();
  const dispatch = (action: WorkflowAction) => onChange(workflowReducer(state, action));

  return <SafeAreaView style={screenStyles.safe}>
    <View style={screenStyles.header}>
      <Text style={screenStyles.eyebrow}>WORKFLOW</Text>
      <Text accessibilityRole="header" style={screenStyles.title}>Practice operations</Text>
      <Text style={screenStyles.subtitle}>Cases, commitments, schedule, and revenue in one place.</Text>
    </View>
    <View accessibilityRole="tablist" style={screenStyles.navWrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={screenStyles.nav}>
        {TABS.map((item) => <TouchableOpacity key={item.value} accessibilityRole="tab" accessibilityState={{ selected: tab === item.value }} onPress={() => setTab(item.value)} style={[screenStyles.navItem, tab === item.value && screenStyles.navItemActive]}><Text style={[screenStyles.navText, tab === item.value && screenStyles.navTextActive]}>{item.label}</Text></TouchableOpacity>)}
      </ScrollView>
    </View>
    <ScrollView style={screenStyles.scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={screenStyles.content}>
      {tab === 'overview' ? <Overview state={state} openCases={() => setTab('cases')} /> : null}
      {tab === 'cases' ? <CasesView {...props} dispatch={dispatch} selectedCaseId={selectedCaseId} setSelectedCaseId={setSelectedCaseId} /> : null}
      {tab === 'schedule' ? <ScheduleView {...props} dispatch={dispatch} /> : null}
      {tab === 'tasks' ? <TasksView state={state} dispatch={dispatch} /> : null}
      {tab === 'revenue' ? <RevenueView state={state} dispatch={dispatch} /> : null}
      {tab === 'settings' ? <ImportView {...props} /> : null}
    </ScrollView>
  </SafeAreaView>;
}

function Overview({ state, openCases }: { state: WorkflowState; openCases: () => void }) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const today = localDateStamp();
  const appointments = selectTodaysAppointments(state, zone, today);
  const tasks = selectOpenTasks(state);
  const pipeline = selectPipelineCounts(state);
  const revenue = selectRevenue(state, today);
  const outstanding = selectOutstandingBalanceCents(state);
  return <>
    <Section title="Today" subtitle={`${today} · ${zone}`}>
      <View style={screenStyles.metricGrid}>
        <Metric label="Appointments" value={String(appointments.length)} />
        <Metric label="Open tasks" value={String(tasks.length)} />
        <Metric label="Received MTD" value={money(revenue.mtdCents)} />
        <Metric label="Received YTD" value={money(revenue.ytdCents)} />
        <Metric label="Outstanding" value={money(outstanding)} tone="coral" />
      </View>
    </Section>
    <Section title="Active pipeline" action={<Button label="View cases" tone="quiet" onPress={openCases} />}>
      <Card tone="mint"><View style={screenStyles.pipeline}>{CASE_STATUSES.map((status) => <View key={status} style={screenStyles.pipelineItem}><Text style={screenStyles.pipelineNumber}>{pipeline[status]}</Text><Text style={screenStyles.pipelineLabel}>{titleCase(status)}</Text></View>)}</View></Card>
    </Section>
    <Section title="Today's appointments">
      {appointments.length === 0 ? <Empty>No appointments today.</Empty> : appointments.map((item) => <Card key={item.id}><Text style={screenStyles.itemTitle}>{item.title}</Text><Text style={screenStyles.meta}>{displayInstant(item.startsAt, item.timeZone)}–{new Intl.DateTimeFormat('en-US', { timeStyle: 'short', timeZone: item.timeZone }).format(new Date(item.endsAt))}</Text><Text style={screenStyles.meta}>{caseName(state, item.caseId)}</Text></Card>)}
    </Section>
    <Section title="Open tasks" subtitle="Ordered by due date">
      {tasks.length === 0 ? <Empty>No open tasks.</Empty> : tasks.slice(0, 8).map((task) => <Card key={task.id}><Text style={screenStyles.itemTitle}>{task.title}</Text><Text style={screenStyles.meta}>{task.dueDate ? `Due ${task.dueDate}` : 'No due date'} · {caseName(state, task.caseId)}</Text></Card>)}
    </Section>
  </>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'coral' }) {
  return <View style={[screenStyles.metric, tone === 'coral' && screenStyles.metricCoral]}><Text style={screenStyles.metricValue}>{value}</Text><Text style={screenStyles.metricLabel}>{label}</Text></View>;
}

interface DispatchProps { dispatch: (action: WorkflowAction) => void }

function CasesView(props: WorkflowScreenProps & DispatchProps & { selectedCaseId?: string; setSelectedCaseId: (id?: string) => void }) {
  const { state, dispatch, selectedCaseId, setSelectedCaseId } = props;
  const [filter, setFilter] = useState<CaseFilter>('intervention');
  const [editing, setEditing] = useState<WorkflowCase | 'new'>();
  const detail = selectedCaseId ? selectCaseDetail(state, selectedCaseId) : undefined;
  const cases = Object.values(state.cases).filter((item) => filter === 'archived' ? item.archivedAt !== null : item.archivedAt === null && item.kind === filter).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (detail) return <CaseDetailView {...props} detail={detail} close={() => setSelectedCaseId(undefined)} edit={() => setEditing(detail.case)} editing={editing} setEditing={setEditing} />;
  return <>
    <Section title="Cases" subtitle="Status changes are explicit and never inferred from other activity." action={<Button label="New case" onPress={() => setEditing('new')} />}>
      <Row>{(['intervention', 'coaching', 'archived'] as const).map((value) => <Button key={value} label={titleCase(value)} tone="secondary" selected={filter === value} onPress={() => setFilter(value)} />)}</Row>
    </Section>
    {editing ? <CaseForm key={editing === 'new' ? 'new' : editing.id} existing={editing === 'new' ? undefined : editing} {...props} dispatch={dispatch} onClose={() => setEditing(undefined)} onSaved={(id) => { setEditing(undefined); setSelectedCaseId(id); }} /> : null}
    <Section title={`${titleCase(filter)} cases`}>
      {cases.length === 0 ? <Empty>No cases in this view.</Empty> : cases.map((item) => <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Open ${item.name}`} key={item.id} onPress={() => setSelectedCaseId(item.id)}><Card><Row><Badge tone={item.archivedAt ? 'coral' : 'mint'}>{item.archivedAt ? 'Archived' : item.kind}</Badge><Badge tone="gold">{titleCase(item.status)}</Badge></Row><Text style={screenStyles.itemTitle}>{item.name}</Text><Text style={screenStyles.meta}>{item.identifiedPatientName || 'Identified patient not recorded'}</Text><Text style={screenStyles.link}>Open case →</Text></Card></TouchableOpacity>)}
    </Section>
  </>;
}

type CaseDraft = { name: string; kind: CaseKind; status: CaseStatus; identifiedPatientName: string; primarySubstance: string; contact: string; notes: string; focus: string; referralId: string; referralMatchId: string; placementPartnerId: string };
function CaseForm({ existing, state, referrals, referralMatches, partners, dispatch, onClose, onSaved }: WorkflowScreenProps & DispatchProps & { existing?: WorkflowCase; onClose: () => void; onSaved: (id: string) => void }) {
  const [draft, setDraft] = useState<CaseDraft>({
    name: existing?.name ?? '', kind: existing?.kind ?? 'intervention', status: existing?.status ?? 'new',
    identifiedPatientName: existing?.identifiedPatientName ?? '', primarySubstance: existing?.primarySubstance ?? '', contact: existing?.contact ?? '', notes: existing?.notes ?? '', focus: existing?.focus ?? '',
    referralId: existing?.referralId ?? '', referralMatchId: existing?.referralMatchId ?? '', placementPartnerId: existing?.placementPartnerId ?? '',
  });
  const [error, setError] = useState('');
  const change = <K extends keyof CaseDraft>(key: K, value: CaseDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const save = () => {
    if (!draft.name.trim()) { setError('Case name is required.'); return; }
    const timestamp = nowIso(); const id = existing?.id ?? workflowId('case');
    const value: WorkflowCase = {
      id, name: draft.name.trim(), kind: draft.kind, status: draft.status, archivedAt: existing?.archivedAt ?? null,
      identifiedPatientName: optional(draft.identifiedPatientName), primarySubstance: optional(draft.primarySubstance), contact: optional(draft.contact), notes: optional(draft.notes), focus: optional(draft.focus),
      referralId: optional(draft.referralId), referralMatchId: optional(draft.referralMatchId), placementPartnerId: optional(draft.placementPartnerId),
      createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp, ...(existing?.legacy ? { legacy: existing.legacy } : {}),
    };
    dispatch({ type: 'case/upsert', value }); onSaved(id);
  };
  const referralChoices = referrals.map((item) => ({ value: item.id, label: item.clientLabel || item.id, detail: item.partnerId ? `Partner: ${partners.find((p) => p.id === item.partnerId)?.organization || item.partnerId}` : undefined }));
  const matchChoices = referralMatches.map((item) => ({ value: item.id, label: item.clientLabel || item.id }));
  const partnerChoices = partners.map((item) => ({ value: item.id, label: item.organization || item.name, detail: item.organization ? item.name : undefined }));
  return <Section title={existing ? 'Edit case' : 'Create case'}><Card tone="mint">
    <Field label="Case name *" value={draft.name} onChangeText={(v) => { change('name', v); setError(''); }} error={error} />
    <ChoiceField label="Case type" value={draft.kind} options={[{ value: 'intervention', label: 'Intervention' }, { value: 'coaching', label: 'Coaching' }]} onChange={(v) => change('kind', v as CaseKind)} />
    <ChoiceField label="Status" value={draft.status} options={STATUS_CHOICES} onChange={(v) => change('status', v as CaseStatus)} />
    <Field label="Identified patient" value={draft.identifiedPatientName} onChangeText={(v) => change('identifiedPatientName', v)} />
    <Field label="Primary substance" value={draft.primarySubstance} onChangeText={(v) => change('primarySubstance', v)} />
    <Field label="Primary contact" value={draft.contact} onChangeText={(v) => change('contact', v)} />
    <ChoiceField label="Linked referral" value={draft.referralId} options={referralChoices} allowEmpty emptyLabel="No referral link" onChange={(v) => change('referralId', v)} />
    <ChoiceField label="Linked referral match" value={draft.referralMatchId} options={matchChoices} allowEmpty emptyLabel="No referral-match link" onChange={(v) => change('referralMatchId', v)} />
    <ChoiceField label="Placement partner" value={draft.placementPartnerId} options={partnerChoices} allowEmpty emptyLabel="No placement link" onChange={(v) => change('placementPartnerId', v)} />
    <Field label="Overview notes" value={draft.notes} multiline onChangeText={(v) => change('notes', v)} />
    <Field label="Current focus" value={draft.focus} multiline onChangeText={(v) => change('focus', v)} />
    <Row><Button label="Save case" onPress={save} /><Button label="Cancel" tone="quiet" onPress={onClose} /></Row>
  </Card></Section>;
}

function CaseDetailView(props: WorkflowScreenProps & DispatchProps & { detail: NonNullable<ReturnType<typeof selectCaseDetail>>; close: () => void; edit: () => void; editing?: WorkflowCase | 'new'; setEditing: (value?: WorkflowCase | 'new') => void }) {
  const { state, detail, dispatch, close, edit, editing, setEditing, referrals, referralMatches, partners } = props;
  const item = detail.case;
  const referral = referrals.find((row) => row.id === item.referralId);
  const match = referralMatches.find((row) => row.id === item.referralMatchId);
  const placement = partners.find((row) => row.id === item.placementPartnerId);
  const archive = () => confirm('Archive case?', `${item.name} will move out of active case lists. Linked records are retained.`, () => dispatch({ type: 'case/archive', id: item.id, at: nowIso() }));
  return <>
    <Row><Button label="← All cases" tone="quiet" onPress={close} /><Button label="Edit" tone="secondary" onPress={edit} />{item.archivedAt ? <Button label="Restore" onPress={() => dispatch({ type: 'case/restore', id: item.id, at: nowIso() })} /> : <Button label="Archive" tone="danger" onPress={archive} />}</Row>
    <View style={screenStyles.detailTitle}><Badge>{item.kind}</Badge><Badge tone="gold">{titleCase(item.status)}</Badge><Text accessibilityRole="header" style={screenStyles.detailName}>{item.name}</Text></View>
    {editing ? <CaseForm key={item.updatedAt} existing={item} {...props} dispatch={dispatch} onClose={() => setEditing(undefined)} onSaved={() => setEditing(undefined)} /> : null}
    <Section title="Overview / notes / focus"><Card>
      <LabelValue label="Identified patient" value={item.identifiedPatientName} /><LabelValue label="Primary substance" value={item.primarySubstance} /><LabelValue label="Primary contact" value={item.contact} />
      <Divider /><LabelValue label="Overview notes" value={item.notes} long /><LabelValue label="Current focus" value={item.focus} long />
      <Divider /><Text style={screenStyles.subhead}>Explicit case links</Text>
      <LabelValue label="Referral" value={referral ? `${referral.clientLabel} (${referral.id})` : item.referralId ? `Missing referral (${item.referralId})` : undefined} />
      <LabelValue label="Referral match" value={match ? `${match.clientLabel} (${match.id})` : item.referralMatchId ? `Missing match (${item.referralMatchId})` : undefined} />
      <LabelValue label="Placement" value={placement ? `${placement.organization || placement.name} (${placement.id})` : item.placementPartnerId ? `Missing partner (${item.placementPartnerId})` : undefined} />
    </Card></Section>
    <ParticipantsSection {...props} caseId={item.id} participants={detail.participants} dispatch={dispatch} />
    <ChecklistSection caseId={item.id} state={state} dispatch={dispatch} />
    <CaseTasks caseId={item.id} state={state} tasks={detail.tasks} dispatch={dispatch} />
    <CaseAppointments {...props} caseId={item.id} appointments={detail.appointments} dispatch={dispatch} />
    <CasePayments caseId={item.id} payments={detail.payments} outstanding={detail.outstandingBalanceCents} dispatch={dispatch} />
    <DocumentsSection {...props} caseId={item.id} documents={detail.documents} dispatch={dispatch} />
  </>;
}

function LabelValue({ label, value, long }: { label: string; value?: string; long?: boolean }) { return <View style={screenStyles.labelValue}><Text style={screenStyles.label}>{label}</Text><Text style={[screenStyles.value, long && screenStyles.longValue]}>{value || 'Not recorded'}</Text></View>; }

function ParticipantsSection({ caseId, participants, dispatch, onRequestContactSync }: DispatchProps & Pick<WorkflowScreenProps, 'onRequestContactSync'> & { caseId: string; participants: Participant[] }) {
  const [editing, setEditing] = useState<Participant | 'new'>();
  const [addingContactId, setAddingContactId] = useState<string>();
  const addContact = async (person: Participant) => {
    if (!onRequestContactSync || addingContactId) return;
    setAddingContactId(person.id);
    try { await onRequestContactSync(person); } finally { setAddingContactId(undefined); }
  };
  return <Section title="Participants" action={<Button label="Add" tone="secondary" onPress={() => setEditing('new')} />}>
    {editing ? <ParticipantForm key={editing === 'new' ? 'new' : editing.id} caseId={caseId} existing={editing === 'new' ? undefined : editing} dispatch={dispatch} close={() => setEditing(undefined)} /> : null}
    {participants.length === 0 ? <Empty>No participants recorded.</Empty> : participants.map((person) => <Card key={person.id}><Text style={screenStyles.itemTitle}>{person.name}</Text><Text style={screenStyles.meta}>{[person.role, person.phone, person.email].filter(Boolean).join(' · ') || 'No contact details'}</Text>{person.notes ? <Text style={screenStyles.body}>{person.notes}</Text> : null}<Row><Button label="Edit" tone="quiet" onPress={() => setEditing(person)} />{onRequestContactSync ? <Button label={addingContactId === person.id ? 'Opening Contacts…' : 'Add to Contacts'} disabled={Boolean(addingContactId)} tone="secondary" onPress={() => void addContact(person)} /> : null}<Button label="Delete" tone="danger" onPress={() => confirm('Delete participant?', `${person.name} will be permanently removed from this workflow.`, () => dispatch({ type: 'participant/remove', id: person.id }))} /></Row></Card>)}
  </Section>;
}

function ParticipantForm({ caseId, existing, dispatch, close }: DispatchProps & { caseId: string; existing?: Participant; close: () => void }) {
  const [name, setName] = useState(existing?.name ?? ''); const [role, setRole] = useState(existing?.role ?? ''); const [phone, setPhone] = useState(existing?.phone ?? ''); const [email, setEmail] = useState(existing?.email ?? ''); const [notes, setNotes] = useState(existing?.notes ?? ''); const [error, setError] = useState('');
  const save = () => { if (!name.trim()) { setError('Participant name is required.'); return; } dispatch({ type: 'participant/upsert', value: { id: existing?.id ?? workflowId('participant'), caseId, name: name.trim(), role: optional(role), phone: optional(phone), email: optional(email), notes: optional(notes), ...(existing?.legacy ? { legacy: existing.legacy } : {}) } }); close(); };
  return <Card tone="mint"><Field label="Name *" value={name} onChangeText={(v) => { setName(v); setError(''); }} error={error} /><Field label="Role" value={role} onChangeText={setRole} /><Field label="Phone" value={phone} keyboardType="phone-pad" onChangeText={setPhone} /><Field label="Email" value={email} keyboardType="email-address" autoCapitalize="none" onChangeText={setEmail} /><Field label="Notes" value={notes} multiline onChangeText={setNotes} /><Row><Button label="Save participant" onPress={save} /><Button label="Cancel" tone="quiet" onPress={close} /></Row></Card>;
}

function ChecklistSection({ caseId, state, dispatch }: DispatchProps & { caseId: string; state: WorkflowState }) {
  const existing = Object.values(state.checklistItems).filter((row) => row.caseId === caseId);
  return <Section title="Intervention checklist" subtitle="Standard seven-item workflow; each item can be completed or reopened.">
    <Card>{CHECKLIST.map(([key, label]) => { const item = existing.find((row) => row.key === key); const complete = Boolean(item?.completedAt); const id = item?.id ?? workflowId('checklist'); const toggle = () => { if (!item) dispatch({ type: 'checklist/upsert', value: { id, caseId, key, label, completedAt: nowIso() } }); else dispatch({ type: complete ? 'checklist/reopen' : 'checklist/complete', id: item.id, at: nowIso() }); }; return <TouchableOpacity key={key} accessibilityLabel={label} accessibilityRole="checkbox" accessibilityState={{ checked: complete }} onPress={toggle} style={screenStyles.checkRow}><Text style={[screenStyles.checkMark, complete && screenStyles.checkMarkDone]}>{complete ? '✓' : '○'}</Text><Text style={[screenStyles.checkLabel, complete && screenStyles.done]}>{label}</Text><Text style={screenStyles.link}>{complete ? 'Reopen' : 'Complete'}</Text></TouchableOpacity>; })}</Card>
  </Section>;
}

function CaseTasks({ caseId, state, tasks, dispatch }: DispatchProps & { caseId: string; state: WorkflowState; tasks: WorkflowTask[] }) {
  const [adding, setAdding] = useState(false);
  return <Section title="Case tasks" action={<Button label="Add" tone="secondary" onPress={() => setAdding(true)} />}>
    {adding ? <TaskForm caseId={caseId} state={state} dispatch={dispatch} close={() => setAdding(false)} /> : null}
    {tasks.length === 0 ? <Empty>No tasks linked to this case.</Empty> : tasks.sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')).map((task) => <TaskCard key={task.id} task={task} state={state} dispatch={dispatch} />)}
  </Section>;
}

function TaskCard({ task, state, dispatch }: DispatchProps & { task: WorkflowTask; state: WorkflowState }) {
  const complete = task.completedAt !== null;
  return <Card><Text style={[screenStyles.itemTitle, complete && screenStyles.done]}>{task.title}</Text><Text style={screenStyles.meta}>{task.dueDate ? `Due ${task.dueDate}` : 'No due date'} · {caseName(state, task.caseId)}</Text>{task.note ? <Text style={screenStyles.body}>{task.note}</Text> : null}<Row><Button label={complete ? 'Reopen' : 'Complete'} tone={complete ? 'quiet' : 'secondary'} onPress={() => dispatch({ type: complete ? 'task/reopen' : 'task/complete', id: task.id, at: nowIso() })} /><Button label="Delete" tone="danger" onPress={() => confirm('Delete task?', 'This task will be permanently removed.', () => dispatch({ type: 'task/remove', id: task.id }))} /></Row></Card>;
}

function TaskForm({ caseId, state, dispatch, close }: DispatchProps & { caseId?: string; state: WorkflowState; close: () => void }) {
  const [title, setTitle] = useState(''); const [dueDate, setDueDate] = useState(''); const [note, setNote] = useState(''); const [linkedCase, setLinkedCase] = useState(caseId ?? ''); const [error, setError] = useState('');
  const save = () => { if (!title.trim()) { setError('Task title is required.'); return; } if (dueDate && !isDateOnly(dueDate)) { setError('Due date must be a real date in YYYY-MM-DD format.'); return; } const timestamp = nowIso(); dispatch({ type: 'task/upsert', value: { id: workflowId('task'), title: title.trim(), caseId: optional(linkedCase), dueDate: optional(dueDate), note: optional(note), completedAt: null, createdAt: timestamp, updatedAt: timestamp } }); close(); };
  const activeCases = Object.values(state.cases).filter((row) => !row.archivedAt).map((row) => ({ value: row.id, label: row.name }));
  return <Card tone="mint"><Field label="Task title *" value={title} onChangeText={(v) => { setTitle(v); setError(''); }} error={error} /><Field label="Due date" placeholder="YYYY-MM-DD" value={dueDate} onChangeText={(v) => { setDueDate(v); setError(''); }} /><ChoiceField label="Linked case" value={linkedCase} options={activeCases} allowEmpty emptyLabel="General task" onChange={setLinkedCase} /><Field label="Note" value={note} multiline onChangeText={setNote} /><Row><Button label="Save task" onPress={save} /><Button label="Cancel" tone="quiet" onPress={close} /></Row></Card>;
}

function CaseAppointments(props: WorkflowScreenProps & DispatchProps & { caseId: string; appointments: WorkflowAppointment[] }) {
  const { caseId, appointments, dispatch, state, onRequestCalendarSync } = props; const [adding, setAdding] = useState(false);
  return <Section title="Appointments" action={<Button label="Add" tone="secondary" onPress={() => setAdding(true)} />}>
    {adding ? <AppointmentForm caseId={caseId} state={state} dispatch={dispatch} close={() => setAdding(false)} /> : null}
    {appointments.length === 0 ? <Empty>No appointments linked to this case.</Empty> : appointments.sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map((appointment) => <AppointmentCard key={appointment.id} appointment={appointment} state={state} dispatch={dispatch} onSync={onRequestCalendarSync} />)}
  </Section>;
}

function AppointmentCard({ appointment, state, dispatch, onSync }: DispatchProps & { appointment: WorkflowAppointment; state: WorkflowState; onSync?: (appointment: WorkflowAppointment) => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const addToCalendar = async () => { if (!onSync || adding) return; setAdding(true); try { await onSync(appointment); } finally { setAdding(false); } };
  return <Card><Text style={screenStyles.itemTitle}>{appointment.title}</Text><Text style={screenStyles.meta}>{displayInstant(appointment.startsAt, appointment.timeZone)} · {appointment.timeZone}</Text><Text style={screenStyles.meta}>{caseName(state, appointment.caseId)}</Text>{appointment.note ? <Text style={screenStyles.body}>{appointment.note}</Text> : null}<Row>{onSync ? <Button label={adding ? 'Adding…' : 'Add to Calendar'} disabled={adding} tone="secondary" onPress={() => void addToCalendar()} /> : null}<Button label="Delete" tone="danger" onPress={() => confirm('Delete appointment?', 'This appointment reference will be permanently removed.', () => dispatch({ type: 'appointment/remove', id: appointment.id }))} /></Row></Card>;
}

function AppointmentForm({ caseId, state, dispatch, close }: DispatchProps & { caseId?: string; state: WorkflowState; close: () => void }) {
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [title, setTitle] = useState(''); const [starts, setStarts] = useState(''); const [ends, setEnds] = useState(''); const [zone, setZone] = useState(localZone); const [note, setNote] = useState(''); const [linkedCase, setLinkedCase] = useState(caseId ?? ''); const [error, setError] = useState('');
  const save = () => { const startIso = canonicalIso(starts); const endIso = canonicalIso(ends); if (!title.trim()) { setError('Appointment title is required.'); return; } if (!startIso || !endIso) { setError('Start and end must be ISO-8601 date-times, including an offset or Z.'); return; } if (endIso <= startIso) { setError('End must be later than start.'); return; } if (!validIanaTimeZone(zone.trim())) { setError('Time zone must be a valid IANA zone, such as America/Los_Angeles.'); return; } const timestamp = nowIso(); dispatch({ type: 'appointment/upsert', value: { id: workflowId('appointment'), title: title.trim(), caseId: optional(linkedCase), startsAt: startIso, endsAt: endIso, timeZone: zone.trim(), note: optional(note), createdAt: timestamp, updatedAt: timestamp } }); close(); };
  const activeCases = Object.values(state.cases).filter((row) => !row.archivedAt).map((row) => ({ value: row.id, label: row.name }));
  return <Card tone="mint"><Field label="Appointment title *" value={title} onChangeText={(v) => { setTitle(v); setError(''); }} error={error} /><Field label="Starts at *" placeholder="2026-07-22T09:00:00-07:00" value={starts} autoCapitalize="none" onChangeText={(v) => { setStarts(v); setError(''); }} /><Field label="Ends at *" placeholder="2026-07-22T10:00:00-07:00" value={ends} autoCapitalize="none" onChangeText={(v) => { setEnds(v); setError(''); }} /><Field label="IANA time zone *" value={zone} autoCapitalize="none" onChangeText={(v) => { setZone(v); setError(''); }} /><ChoiceField label="Linked case" value={linkedCase} options={activeCases} allowEmpty emptyLabel="General appointment" onChange={setLinkedCase} /><Field label="Note" value={note} multiline onChangeText={setNote} /><Row><Button label="Save appointment" onPress={save} /><Button label="Cancel" tone="quiet" onPress={close} /></Row></Card>;
}

function CasePayments({ caseId, payments, outstanding, dispatch }: DispatchProps & { caseId: string; payments: NonNullable<ReturnType<typeof selectCaseDetail>>['payments']; outstanding: number }) {
  const [adding, setAdding] = useState(false);
  return <Section title="Payments" subtitle={`Outstanding: ${money(outstanding)}`} action={<Button label="Add" tone="secondary" onPress={() => setAdding(true)} />}>
    {adding ? <PaymentForm caseId={caseId} dispatch={dispatch} close={() => setAdding(false)} /> : null}
    {payments.length === 0 ? <Empty>No payment entries.</Empty> : payments.sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate)).map((payment) => <Card key={payment.id}><Row><Text style={screenStyles.money}>{money(payment.amountCents)}</Text><Badge tone={payment.status === 'received' ? 'mint' : 'coral'}>{payment.status}</Badge></Row><Text style={screenStyles.meta}>Effective {payment.effectiveDate}</Text>{payment.note ? <Text style={screenStyles.body}>{payment.note}</Text> : null}<Row><Button label={payment.status === 'pending' ? 'Mark received' : 'Mark pending'} tone="secondary" onPress={() => dispatch({ type: 'payment/upsert', value: { ...payment, status: payment.status === 'pending' ? 'received' : 'pending' } })} /><Button label="Delete" tone="danger" onPress={() => confirm('Delete payment entry?', 'This revenue record will be permanently removed.', () => dispatch({ type: 'payment/remove', id: payment.id }))} /></Row></Card>)}
  </Section>;
}

function PaymentForm({ caseId, dispatch, close }: DispatchProps & { caseId: string; close: () => void }) {
  const [amount, setAmount] = useState(''); const [status, setStatus] = useState<PaymentStatus>('pending'); const [date, setDate] = useState(localDateStamp()); const [note, setNote] = useState(''); const [error, setError] = useState('');
  const save = () => { const cents = parseMoneyToCents(amount); if (!cents) { setError('Enter a positive dollar amount with no more than two decimal places.'); return; } if (!isDateOnly(date)) { setError('Effective date must be a real date in YYYY-MM-DD format.'); return; } dispatch({ type: 'payment/upsert', value: { id: workflowId('payment'), caseId, amountCents: cents, status, effectiveDate: date, note: optional(note) } }); close(); };
  return <Card tone="mint"><Field label="Amount (USD) *" placeholder="7500.00" keyboardType="decimal-pad" value={amount} onChangeText={(v) => { setAmount(v); setError(''); }} error={error} /><ChoiceField label="Status" value={status} options={[{ value: 'pending', label: 'Pending' }, { value: 'received', label: 'Received' }]} onChange={(v) => setStatus(v as PaymentStatus)} /><Field label="Effective date *" placeholder="YYYY-MM-DD" value={date} onChangeText={(v) => { setDate(v); setError(''); }} /><Field label="Note" value={note} onChangeText={setNote} /><Row><Button label="Save payment" onPress={save} /><Button label="Cancel" tone="quiet" onPress={close} /></Row></Card>;
}

function DocumentsSection({ caseId, documents, dispatch, onRequestDocumentPick, onRequestDocumentOpen, onRequestDocumentRemove }: DispatchProps & Pick<WorkflowScreenProps, 'onRequestDocumentPick' | 'onRequestDocumentOpen' | 'onRequestDocumentRemove'> & { caseId: string; documents: NonNullable<ReturnType<typeof selectCaseDetail>>['documents'] }) {
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!onRequestDocumentPick || busy) return;
    setBusy(true);
    try {
      const document = await onRequestDocumentPick(caseId);
      if (document) dispatch({ type: 'document/upsert', value: document });
    } catch (error) {
      Alert.alert('Unable to attach document', error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };
  const open = async (document: CaseDocumentReference) => {
    if (!onRequestDocumentOpen) return;
    try { await onRequestDocumentOpen(document); } catch (error) { Alert.alert('Unable to open document', error instanceof Error ? error.message : String(error)); }
  };
  const remove = async (document: CaseDocumentReference) => {
    try {
      if (document.uri && onRequestDocumentRemove) await onRequestDocumentRemove(document);
      dispatch({ type: 'document/remove', id: document.id });
    } catch (error) { Alert.alert('Unable to remove document', error instanceof Error ? error.message : String(error)); }
  };
  return <Section title="Case documents" subtitle="New attachments are copied into private app-local storage. Imported InterventionOS names remain clearly marked as legacy references."><Card tone="mint"><Text style={screenStyles.notice}>Choose a file only when you want a durable local copy associated with this case.</Text><Button label={busy ? 'Attaching…' : 'Attach document'} disabled={busy || !onRequestDocumentPick} onPress={add} /></Card>{documents.length === 0 ? <Empty>No documents attached.</Empty> : documents.map((document) => <Card key={document.id}><Text style={screenStyles.itemTitle}>{document.name}</Text><Text style={screenStyles.meta}>{document.uri ? `Local attachment${document.size ? ` · ${Math.ceil(document.size / 1024)} KB` : ''}` : 'Legacy name-only reference · no file attached'}</Text><Row>{document.uri && onRequestDocumentOpen ? <Button label="Open" tone="secondary" onPress={() => void open(document)} /> : null}<Button label="Remove" tone="danger" onPress={() => confirm('Remove document?', document.uri ? 'The app-local file and its case reference will be permanently deleted.' : 'Only this legacy name reference will be removed.', () => void remove(document))} /></Row></Card>)}</Section>;
}

function ScheduleView(props: WorkflowScreenProps & DispatchProps) {
  const [adding, setAdding] = useState(false); const appointments = Object.values(props.state.appointments).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return <Section title="Schedule" subtitle="Times are stored as canonical UTC instants and shown in each appointment's IANA time zone." action={<Button label="New appointment" onPress={() => setAdding(true)} />}>
    {adding ? <AppointmentForm state={props.state} dispatch={props.dispatch} close={() => setAdding(false)} /> : null}
    {appointments.length === 0 ? <Empty>No appointments scheduled.</Empty> : appointments.map((appointment) => <AppointmentCard key={appointment.id} appointment={appointment} state={props.state} dispatch={props.dispatch} onSync={props.onRequestCalendarSync} />)}
  </Section>;
}

function TasksView({ state, dispatch }: Pick<WorkflowScreenProps, 'state'> & DispatchProps) {
  const [adding, setAdding] = useState(false); const [showCompleted, setShowCompleted] = useState(false);
  const tasks = Object.values(state.tasks).filter((task) => showCompleted ? task.completedAt !== null : task.completedAt === null).sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
  return <Section title="Tasks" action={<Button label="New task" onPress={() => setAdding(true)} />}>
    <Row><Button label="Open" tone="secondary" selected={!showCompleted} onPress={() => setShowCompleted(false)} /><Button label="Completed" tone="secondary" selected={showCompleted} onPress={() => setShowCompleted(true)} /></Row>
    {adding ? <TaskForm state={state} dispatch={dispatch} close={() => setAdding(false)} /> : null}
    {tasks.length === 0 ? <Empty>No tasks in this view.</Empty> : tasks.map((task) => <TaskCard key={task.id} task={task} state={state} dispatch={dispatch} />)}
  </Section>;
}

function RevenueView({ state, dispatch }: Pick<WorkflowScreenProps, 'state'> & DispatchProps) {
  const today = localDateStamp(); const totals = selectRevenue(state, today); const outstanding = selectOutstandingBalanceCents(state);
  const rows = Object.values(state.payments).sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  return <><Section title="Revenue"><View style={screenStyles.metricGrid}><Metric label="Received MTD" value={money(totals.mtdCents)} /><Metric label="Received YTD" value={money(totals.ytdCents)} /><Metric label="Active outstanding" value={money(outstanding)} tone="coral" /></View></Section><Section title="Payment ledger" subtitle="Outstanding excludes payments on archived cases.">{rows.length === 0 ? <Empty>No payment entries.</Empty> : rows.map((payment) => <Card key={payment.id}><Row><Text style={screenStyles.money}>{money(payment.amountCents)}</Text><Badge tone={payment.status === 'received' ? 'mint' : 'coral'}>{payment.status}</Badge></Row><Text style={screenStyles.meta}>{payment.effectiveDate} · {caseName(state, payment.caseId)}</Text><Button label={payment.status === 'pending' ? 'Mark received' : 'Mark pending'} tone="secondary" onPress={() => dispatch({ type: 'payment/upsert', value: { ...payment, status: payment.status === 'pending' ? 'received' : 'pending' } })} /></Card>)}</Section></>;
}

function ImportView({ state, onChange, onRequestBackupExport, onRequestBackupRestore }: Pick<WorkflowScreenProps, 'state' | 'onChange' | 'onRequestBackupExport' | 'onRequestBackupRestore'>) {
  const defaultZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [json, setJson] = useState(''); const [sourceId, setSourceId] = useState('interventionos'); const [zone, setZone] = useState(defaultZone); const [preview, setPreview] = useState<LegacyImportResult>(); const [previewSignature, setPreviewSignature] = useState(''); const [error, setError] = useState(''); const [confirmed, setConfirmed] = useState(false); const [message, setMessage] = useState('');
  const signature = useMemo(() => `${sourceId}\u0000${zone}\u0000${json}`, [sourceId, zone, json]);
  const resetPreview = () => { setPreview(undefined); setConfirmed(false); setMessage(''); };
  const runImport = (base: WorkflowState) => importLegacyInterventionOS(base, json, { sourceId: sourceId.trim(), importedAt: nowIso(), defaultTimeZone: zone.trim() });
  const inspect = () => { setError(''); setMessage(''); setConfirmed(false); if (!json.trim()) { setError('Paste InterventionOS JSON first.'); return; } try { const result = runImport(state); setPreview(result); setPreviewSignature(signature); } catch (reason) { setPreview(undefined); setError(reason instanceof Error ? reason.message : 'Import could not be parsed.'); } };
  const apply = () => { if (!preview || previewSignature !== signature) { setError('The import input changed. Run preview again.'); return; } if (!confirmed) { setError('Confirm that you reviewed the preview and warnings.'); return; } try { const result = runImport(state); onChange(result.state); setPreview(result); setPreviewSignature(signature); setMessage(result.alreadyImported ? 'This exact source payload was already imported; no workflow data changed.' : 'Workflow data imported successfully. Referral, referral-match, and partner state was not modified.'); setError(''); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Import failed.'); } };
  const [backupBusy, setBackupBusy] = useState(false);
  const runBackupAction = async (action?: () => Promise<void>) => {
    if (!action || backupBusy) return;
    setBackupBusy(true);
    try { await action(); } catch (reason) { Alert.alert('Backup operation failed', reason instanceof Error ? reason.message : String(reason)); } finally { setBackupBusy(false); }
  };
  return <><Section title="Backup and recovery" subtitle="Exports contain the complete local referral and workflow database. Restores are validated and the exact current database is backed up before replacement."><Card tone="coral"><Text style={screenStyles.notice}>Store backups securely; they may contain sensitive case information.</Text><Row><Button label={backupBusy ? 'Working…' : 'Export backup'} disabled={backupBusy || !onRequestBackupExport} onPress={() => void runBackupAction(onRequestBackupExport)} /><Button label="Restore backup" tone="danger" disabled={backupBusy || !onRequestBackupRestore} onPress={() => confirm('Restore ReferralFit backup?', 'The selected backup will replace the current local database only after validation. The exact current database will be preserved under a recovery key.', () => void runBackupAction(onRequestBackupRestore))} /></Row></Card></Section><Section title="Settings / Data Import" subtitle="Strict InterventionOS import. Preview first; nothing changes until explicit confirmation."><Card tone="mint">
    <Field label="Source ID *" value={sourceId} autoCapitalize="none" onChangeText={(v) => { setSourceId(v); resetPreview(); }} />
    <Field label="Default IANA time zone *" value={zone} autoCapitalize="none" onChangeText={(v) => { setZone(v); resetPreview(); }} />
    <Field label="InterventionOS JSON *" value={json} multiline autoCapitalize="none" placeholder={'{"families":[],"scheduleItems":[],"tasks":[]}'} onChangeText={(v) => { setJson(v); resetPreview(); }} />
    {error ? <Text accessibilityRole="alert" style={screenStyles.error}>{error}</Text> : null}
    <Button label="Parse and preview" onPress={inspect} />
  </Card></Section>
  {preview ? <Section title="Import preview" subtitle={`Fingerprint: ${preview.fingerprint}`}><Card tone={preview.warnings.length ? 'coral' : 'white'}>
    <LabelValue label="Cases after import" value={String(Object.keys(preview.state.cases).length)} /><LabelValue label="Participants after import" value={String(Object.keys(preview.state.participants).length)} /><LabelValue label="Tasks after import" value={String(Object.keys(preview.state.tasks).length)} /><LabelValue label="Appointments after import" value={String(Object.keys(preview.state.appointments).length)} /><LabelValue label="Payment entries after import" value={String(Object.keys(preview.state.payments).length)} /><LabelValue label="Import status" value={preview.alreadyImported ? 'Exact payload already imported; applying is a no-op.' : 'New payload ready to import.'} />
    <Divider /><Text style={screenStyles.subhead}>Warnings ({preview.warnings.length})</Text>{preview.warnings.length === 0 ? <Text style={screenStyles.body}>No parser warnings.</Text> : preview.warnings.map((warning, index) => <Text key={`${index}-${warning}`} style={screenStyles.warning}>• {warning}</Text>)}
    <TouchableOpacity accessibilityRole="checkbox" accessibilityState={{ checked: confirmed }} onPress={() => { setConfirmed((value) => !value); setError(''); }} style={screenStyles.confirmRow}><Text style={screenStyles.confirmBox}>{confirmed ? '☑' : '☐'}</Text><Text style={screenStyles.confirmText}>I reviewed this preview and warnings and explicitly confirm the workflow import.</Text></TouchableOpacity>
    <Text style={screenStyles.notice}>Import is idempotent by source ID and payload fingerprint. It changes only WorkflowState; referral, match, and partner arrays are never mutated.</Text>
    <Button label={preview.alreadyImported ? 'Confirm idempotent no-op' : 'Confirm and import'} disabled={!confirmed} onPress={apply} />
    {message ? <Text accessibilityRole="alert" style={screenStyles.success}>{message}</Text> : null}
  </Card></Section> : null}</>;
}

const screenStyles = StyleSheet.create({
  safe: { backgroundColor: COLORS.cream, flex: 1 },
  scroll: { flex: 1 },
  header: { backgroundColor: COLORS.cream, paddingHorizontal: 18, paddingBottom: 12, paddingTop: 14 },
  eyebrow: { color: COLORS.coral, fontSize: 11, fontWeight: '900', letterSpacing: 1.8 },
  title: { color: COLORS.ink, fontSize: 30, fontWeight: '900', letterSpacing: -0.6 },
  subtitle: { color: COLORS.inkSoft, fontSize: 14, lineHeight: 20, marginTop: 3 },
  navWrap: { borderBottomColor: COLORS.line, borderBottomWidth: 1, borderTopColor: COLORS.line, borderTopWidth: 1 },
  nav: { gap: 7, paddingHorizontal: 14, paddingVertical: 9 },
  navItem: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 }, navItemActive: { backgroundColor: COLORS.forest },
  navText: { color: COLORS.inkSoft, fontSize: 13, fontWeight: '800' }, navTextActive: { color: COLORS.white },
  content: { padding: 16, paddingBottom: 80 },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metric: { backgroundColor: COLORS.white, borderColor: COLORS.line, borderRadius: 16, borderWidth: 1, flexGrow: 1, minWidth: 140, padding: 15 }, metricCoral: { backgroundColor: COLORS.coralPale },
  metricValue: { color: COLORS.ink, fontSize: 22, fontWeight: '900' }, metricLabel: { color: COLORS.gray, fontSize: 12, fontWeight: '700', marginTop: 3, textTransform: 'uppercase' },
  pipeline: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, pipelineItem: { alignItems: 'center', minWidth: 82, padding: 8 }, pipelineNumber: { color: COLORS.forest, fontSize: 24, fontWeight: '900' }, pipelineLabel: { color: COLORS.inkSoft, fontSize: 11, fontWeight: '700' },
  itemTitle: { color: COLORS.ink, fontSize: 17, fontWeight: '800' }, meta: { color: COLORS.gray, fontSize: 13, lineHeight: 18 }, body: { color: COLORS.inkSoft, fontSize: 14, lineHeight: 20 }, link: { color: COLORS.forest, fontSize: 13, fontWeight: '800' },
  detailTitle: { gap: 8, marginBottom: 20, marginTop: 14 }, detailName: { color: COLORS.ink, fontSize: 27, fontWeight: '900' }, subhead: { color: COLORS.ink, fontSize: 15, fontWeight: '800' },
  labelValue: { gap: 2 }, label: { color: COLORS.gray, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }, value: { color: COLORS.ink, fontSize: 15 }, longValue: { lineHeight: 22 },
  checkRow: { alignItems: 'center', flexDirection: 'row', gap: 9, minHeight: 52 }, checkMark: { color: COLORS.gray, fontSize: 22, width: 25 }, checkMarkDone: { color: COLORS.forest }, checkLabel: { color: COLORS.ink, flex: 1, fontSize: 14, fontWeight: '600' }, done: { opacity: 0.58, textDecorationLine: 'line-through' },
  money: { color: COLORS.ink, fontSize: 22, fontWeight: '900' }, notice: { color: COLORS.inkSoft, fontSize: 13, fontWeight: '600', lineHeight: 19 },
  error: { color: '#A33E2B', fontSize: 13, fontWeight: '700' }, warning: { color: '#8C3524', fontSize: 13, lineHeight: 19 }, success: { color: COLORS.forest, fontSize: 14, fontWeight: '800', lineHeight: 20 },
  confirmRow: { alignItems: 'flex-start', backgroundColor: COLORS.white, borderColor: COLORS.line, borderRadius: 12, borderWidth: 1, flexDirection: 'row', gap: 10, padding: 13 }, confirmBox: { color: COLORS.forest, fontSize: 22 }, confirmText: { color: COLORS.ink, flex: 1, fontSize: 14, fontWeight: '700', lineHeight: 20 },
});
