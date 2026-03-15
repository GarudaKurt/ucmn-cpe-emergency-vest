"use client";

import { cn } from "@/lib/utils";
import { useState, useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { MdOutlineWarningAmber, MdOutlineSos } from "react-icons/md";
import { TbShirt, TbWind } from "react-icons/tb";
import { RiRfidLine } from "react-icons/ri";
import {
  FiActivity, FiMapPin, FiEye, FiClipboard, FiPlus,
  FiUser, FiUsers, FiHash, FiBriefcase, FiX, FiCheck, FiLoader,
  FiRotateCcw,
} from "react-icons/fi";
import { BsThermometerHalf, BsDroplet } from "react-icons/bs";
import { GiGasMask } from "react-icons/gi";
import { LuAlarmClock } from "react-icons/lu";
import { HiOutlineStatusOnline } from "react-icons/hi";

// Firebase Realtime DB
import { database, firestore } from "../config/firebase";
import { ref, onValue, push } from "firebase/database";

// Firestore
import {
  collection, addDoc, serverTimestamp,
  query, where, getDocs,
  doc, setDoc, getDoc, arrayUnion,
  updateDoc, Timestamp,
} from "firebase/firestore";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawVestData {
  dht22:  string | number;
  dust:   string | number;
  mq135:  string | number;
  mq9:    string | number;
  zoneA:  boolean;
  zoneB:  boolean;
}

interface Vest {
  id:       string;
  name:     string;
  rfidTag:  string;
  status:   "online" | "offline" | "alert" | "rescue";
  zoneA:    boolean;
  zoneB:    boolean;
  temp:     number;
  humidity: number;
  dust:     number;
  aqi:      number;
  coGas:    number;
}

interface AlertLog {
  timestamp: string;
  vest:      string;
  alertType: string;
  zoneA:     boolean;
  zoneB:     boolean;
  dust:      number;
  coGas:     number;
  aqi:       number;
  temp:      number;
  humidity:  number;
}

interface EventLogEntry {
  timestamp: string;
  temp:      number;
  humidity:  number;
  dust:      number;
  aqi:       number;
  coGas:     number;
  status:    string;
  zoneA:     boolean;
  zoneB:     boolean;
}

/**
 * One personnel assignment stored in Firestore `registeredPersonnel`.
 * Each time someone is assigned a vest, a NEW document is created.
 * isReturned = false  → currently in use
 * isReturned = true   → vest has been handed back
 */
interface PersonnelRecord {
  docId:        string;
  name:         string;
  age:          number;
  department:   string;
  assignedVest: string;
  registeredAt: Timestamp | null;
  isReturned:   boolean;
  returnedAt:   Timestamp | null;
}

interface RegisterForm {
  name:         string;
  age:          string;
  department:   string;
  assignedVest: string;
}

const FORM_EMPTY: RegisterForm = { name: "", age: "", department: "", assignedVest: "" };

// ─── Constants ────────────────────────────────────────────────────────────────

const VEST_KEYS = ["Vest1", "Vest2"] as const;
type VestKey = typeof VEST_KEYS[number];

const VEST_META: Record<VestKey, { rfidTag: string }> = {
  Vest1: { rfidTag: "A1B2C3" },
  Vest2: { rfidTag: "D4E5F6" },
};

const DEPARTMENTS = [
  "Operations", "Maintenance", "Engineering",
  "Safety & Compliance", "Logistics", "Management",
];

const THRESHOLDS = { dust: 50, coGas: 1.0, aqi: 150, temp: 37.0 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseVestData(raw: RawVestData) {
  const dhtRaw   = String(raw.dht22);
  const dhtParts = dhtRaw.includes(";") ? dhtRaw.split(";") : [dhtRaw, "0"];
  return {
    temp:     Number(dhtParts[0]) || 0,
    humidity: Number(dhtParts[1]) || 0,
    dust:     Number(raw.dust)    || 0,
    aqi:      Number(raw.mq135)   || 0,
    coGas:    Number(raw.mq9)     || 0,
    zoneA:    Boolean(raw.zoneA),
    zoneB:    Boolean(raw.zoneB),
  };
}

function deriveStatus(s: ReturnType<typeof parseVestData>): Vest["status"] {
  if (s.temp > THRESHOLDS.temp) return "rescue";
  if (s.dust > THRESHOLDS.dust || s.coGas > THRESHOLDS.coGas || s.aqi > THRESHOLDS.aqi) return "alert";
  return "online";
}

function deriveAlertType(s: ReturnType<typeof parseVestData>): string | null {
  if (s.temp  > THRESHOLDS.temp)  return "Need Rescue";
  if (s.dust  > THRESHOLDS.dust)  return "High Dust";
  if (s.coGas > THRESHOLDS.coGas) return "High CO Gas";
  if (s.aqi   > THRESHOLDS.aqi)   return "High AQI";
  return null;
}

function formatTs(ts: Timestamp | null): string {
  if (!ts) return "—";
  return ts.toDate().toLocaleString("en-PH", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

async function saveEventLog(vestId: string, entry: EventLogEntry) {
  try {
    await setDoc(doc(firestore, "eventLogs", vestId), { history: arrayUnion(entry) }, { merge: true });
  } catch (err) { console.error("eventLogs write error:", err); }
}

/** Fetch ALL personnel records for a vest, newest first (sorted client-side — no composite index needed) */
async function fetchVestPersonnel(vestId: string): Promise<PersonnelRecord[]> {
  try {
    const q    = query(collection(firestore, "registeredPersonnel"), where("assignedVest", "==", vestId));
    const snap = await getDocs(q);
    const docs = snap.docs.map((d) => ({ docId: d.id, ...(d.data() as Omit<PersonnelRecord, "docId">) }));
    // Sort newest-first client-side — avoids needing a composite Firestore index
    return docs.sort((a, b) => {
      const at = a.registeredAt?.toMillis() ?? 0;
      const bt = b.registeredAt?.toMillis() ?? 0;
      return bt - at;
    });
  } catch (err) { console.error("fetchVestPersonnel error:", err); return []; }
}

async function fetchEventLogs(vestId: string): Promise<EventLogEntry[]> {
  try {
    const snap = await getDoc(doc(firestore, "eventLogs", vestId));
    if (!snap.exists()) return [];
    return (snap.data()?.history as EventLogEntry[]) ?? [];
  } catch (err) { console.error("eventLogs fetch error:", err); return []; }
}

/** Fetch only the current active (non-returned) user for a vest — no composite index needed */
async function fetchActiveUser(vestId: string): Promise<PersonnelRecord | null> {
  try {
    // Query only on assignedVest (single-field index, always exists by default)
    // then filter isReturned and sort client-side to avoid needing a composite index
    const q    = query(collection(firestore, "registeredPersonnel"), where("assignedVest", "==", vestId));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const active = snap.docs
      .map((d) => ({ docId: d.id, ...(d.data() as Omit<PersonnelRecord, "docId">) }))
      .filter((r) => r.isReturned === false)
      .sort((a, b) => (b.registeredAt?.toMillis() ?? 0) - (a.registeredAt?.toMillis() ?? 0));
    return active[0] ?? null;
  } catch (err) { console.error("fetchActiveUser error:", err); return null; }
}

async function markVestReturned(docId: string): Promise<void> {
  await updateDoc(doc(firestore, "registeredPersonnel", docId), {
    isReturned: true,
    returnedAt: serverTimestamp(),
  });
}

/**
 * Fetch all unique people who have ever been registered in `registeredPersonnel`.
 * De-duplicated by name+department, keeping the most recent record per person.
 * This powers the Registered Users table.
 */
interface UniqueUser {
  key:          string;           // name|department
  name:         string;
  department:   string;
  age:          number;
  latestRecord: PersonnelRecord;  // most recent assignment (any vest, any state)
}

async function fetchUniqueUsers(): Promise<UniqueUser[]> {
  try {
    const snap = await getDocs(collection(firestore, "registeredPersonnel"));
    const allDocs = snap.docs.map((d) => ({ docId: d.id, ...(d.data() as Omit<PersonnelRecord, "docId">) }));

    // Group by name+department, keep newest record per person
    const map = new Map<string, UniqueUser>();
    for (const record of allDocs) {
      const key = `${record.name}|${record.department}`;
      const existing = map.get(key);
      const recordMs = record.registeredAt?.toMillis() ?? 0;
      const existMs  = existing?.latestRecord.registeredAt?.toMillis() ?? -1;
      if (!existing || recordMs > existMs) {
        map.set(key, { key, name: record.name, department: record.department, age: record.age, latestRecord: record });
      }
    }

    // Sort alphabetically by name
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) { console.error("fetchUniqueUsers error:", err); return []; }
}

/** Assign an existing person to a vest by creating a new registeredPersonnel doc */
async function assignUserToVest(user: UniqueUser, vestId: string): Promise<void> {
  await addDoc(collection(firestore, "registeredPersonnel"), {
    name:         user.name,
    age:          user.age,
    department:   user.department,
    assignedVest: vestId,
    registeredAt: serverTimestamp(),
    isReturned:   false,
    returnedAt:   null,
  });
}

// ─── Status Config ────────────────────────────────────────────────────────────

const statusConfig: Record<Vest["status"], { label: string; className: string; dot: string }> = {
  online:  { label: "Online",      className: "border-emerald-200 bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  offline: { label: "Offline",     className: "border-slate-200 bg-slate-50 text-slate-500",       dot: "bg-slate-400" },
  alert:   { label: "Alert",       className: "border-amber-200 bg-amber-50 text-amber-700",       dot: "bg-amber-500 animate-pulse" },
  rescue:  { label: "Need Rescue", className: "border-red-200 bg-red-50 text-red-700",             dot: "bg-red-500 animate-pulse" },
};

// ─── Sub-components ───────────────────────────────────────────────────────────



function StatCard({ label, value, icon: Icon, iconColor, iconBg, valueColor, borderColor }: {
  label: string; value: number | string; icon: React.ElementType;
  iconColor: string; iconBg: string; valueColor: string; borderColor: string;
}) {
  return (
    <div className={cn("rounded-2xl border bg-white p-5 shadow-sm flex flex-col gap-3", borderColor)}>
      <div className={cn("h-10 w-10 rounded-xl flex items-center justify-center", iconBg)}>
        <Icon className={cn("text-xl", iconColor)} />
      </div>
      <div>
        <p className="text-slate-400 text-xs uppercase tracking-widest mb-0.5">{label}</p>
        <span className={cn("text-3xl font-bold tabular-nums", valueColor)}>{value}</span>
      </div>
    </div>
  );
}

function SectionHeader({ icon: Icon, label, iconColor, badge }: {
  icon: React.ElementType; label: string; iconColor: string; badge?: number;
}) {
  return (
    <h2 className="text-slate-800 text-base font-semibold mb-4 tracking-wide flex items-center gap-2">
      <Icon className={cn("text-lg", iconColor)} />
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="ml-1 inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-full bg-red-500 text-white text-xs font-bold">
          {badge}
        </span>
      )}
    </h2>
  );
}

function FormField({ label, icon: Icon, error, children }: {
  label: string; icon: React.ElementType; error?: string; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-slate-600 text-sm font-medium flex items-center gap-1.5">
        <Icon className="text-slate-400 text-base" /> {label}
      </Label>
      {children}
      {error && <p className="text-red-500 text-xs">{error}</p>}
    </div>
  );
}

function ZoneBadge({ active }: { active: boolean }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
      active ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-400"
    )}>
      <span className={cn("h-1.5 w-1.5 rounded-full", active ? "bg-emerald-500" : "bg-slate-300")} />
      {active ? "Active" : "Inactive"}
    </span>
  );
}

function ReturnBadge({ returned }: { returned: boolean }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
      returned
        ? "border-slate-200 bg-slate-50 text-slate-500"
        : "border-blue-200 bg-blue-50 text-blue-700"
    )}>
      <span className={cn("h-1.5 w-1.5 rounded-full", returned ? "bg-slate-400" : "bg-blue-500")} />
      {returned ? "Returned" : "In Use"}
    </span>
  );
}

// ─── Sensor Event Log Modal ───────────────────────────────────────────────────

function EventLogModal({ open, onClose, vestId, activeUserName }: {
  open:           boolean;
  onClose:        () => void;
  vestId:         string;
  activeUserName: string | null;
}) {
  const [logs, setLogs]       = useState<EventLogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchEventLogs(vestId).then((entries) => {
      setLogs([...entries].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)));
      setLoading(false);
    });
  }, [open, vestId]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-4xl w-full bg-white rounded-2xl p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-blue-50 flex items-center justify-center shrink-0">
              <FiEye className="text-blue-600 text-lg" />
            </div>
            <div>
              <DialogTitle className="text-slate-900 text-base font-semibold">
                Sensor Event Log — {vestId}
              </DialogTitle>
              <p className="text-slate-400 text-xs mt-0.5">
                {activeUserName ? `Current user: ${activeUserName}` : "No active user"}
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="overflow-auto max-h-[60vh] px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-16 gap-2 text-slate-400">
              <FiLoader className="animate-spin text-lg" />
              <span className="text-sm">Loading event logs…</span>
            </div>
          ) : logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2">
              <LuAlarmClock className="text-3xl text-slate-300" />
              <p className="text-slate-400 text-sm">No event logs recorded yet.</p>
              <p className="text-slate-300 text-xs">Logs are saved automatically every 15 s from the ESP32.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-slate-100 hover:bg-transparent bg-slate-50">
                  {["Timestamp", "Status", "Temp (°C)", "Humidity (%)", "Dust (µg/m³)", "AQI", "CO Gas (ppm)", "IsZoneA", "IsZoneB"].map((h) => (
                    <TableHead key={h} className="text-slate-500 text-xs uppercase tracking-wider font-semibold whitespace-nowrap">{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((entry, i) => {
                  const sc = statusConfig[entry.status as Vest["status"]] ?? statusConfig.online;
                  return (
                    <TableRow key={i} className="border-slate-100 hover:bg-slate-50 transition-colors">
                      <TableCell className="text-slate-400 font-mono text-xs whitespace-nowrap">{entry.timestamp.replace("T", " ").slice(0, 19)}</TableCell>
                      <TableCell>
                        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", sc.className)}>
                          <span className={cn("h-1.5 w-1.5 rounded-full", sc.dot)} />{sc.label}
                        </span>
                      </TableCell>
                      <TableCell className={cn("font-mono text-sm font-semibold", entry.temp  > THRESHOLDS.temp  ? "text-red-500"   : "text-blue-500")}>{entry.temp.toFixed(1)}</TableCell>
                      <TableCell className="text-purple-600 font-mono text-sm font-semibold">{entry.humidity.toFixed(1)}</TableCell>
                      <TableCell className={cn("font-mono text-sm font-semibold", entry.dust  > THRESHOLDS.dust  ? "text-red-500"   : "text-emerald-600")}>{entry.dust.toFixed(1)}</TableCell>
                      <TableCell className={cn("font-mono text-sm font-semibold", entry.aqi   > THRESHOLDS.aqi   ? "text-amber-500" : "text-emerald-600")}>{entry.aqi.toFixed(0)}</TableCell>
                      <TableCell className={cn("font-mono text-sm font-semibold", entry.coGas > THRESHOLDS.coGas ? "text-amber-500" : "text-emerald-600")}>{entry.coGas.toFixed(2)}</TableCell>
                      <TableCell><ZoneBadge active={entry.zoneA} /></TableCell>
                      <TableCell><ZoneBadge active={entry.zoneB} /></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>

        {!loading && logs.length > 0 && (
          <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between">
            <p className="text-slate-400 text-xs">{logs.length} record{logs.length !== 1 ? "s" : ""} total</p>
            <Button size="sm" variant="outline" onClick={onClose} className="rounded-xl border-slate-200 text-slate-600 text-xs h-7 px-4">Close</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Vest Personnel History Modal ─────────────────────────────────────────────
// Displays ALL users who have ever used this vest.
// The "IsReturn" column lets admins mark a vest as returned,
// which frees it up for the next user to be registered.

function VestHistoryModal({ open, onClose, vestId, liveVest, onReturnSuccess }: {
  open:            boolean;
  onClose:         () => void;
  vestId:          string;
  liveVest:        Vest | undefined;
  onReturnSuccess: (vestId: string) => void;
}) {
  const [records, setRecords]         = useState<PersonnelRecord[]>([]);
  const [loading, setLoading]         = useState(false);
  const [returningId, setReturningId] = useState<string | null>(null);
  const [sensorLogOpen, setSensorLogOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchVestPersonnel(vestId).then((data) => {
      setRecords(data);
      setLoading(false);
    });
  }, [open, vestId]);

  async function handleReturn(record: PersonnelRecord) {
    setReturningId(record.docId);
    try {
      await markVestReturned(record.docId);
      // Optimistic update — flip isReturned locally
      setRecords((prev) =>
        prev.map((r) =>
          r.docId === record.docId
            ? { ...r, isReturned: true, returnedAt: Timestamp.now() }
            : r
        )
      );
      onReturnSuccess(vestId);
    } catch (err) {
      console.error("Return error:", err);
    } finally {
      setReturningId(null);
    }
  }

  const activeUser = records.find((r) => !r.isReturned);
  const sc = liveVest ? statusConfig[liveVest.status] : statusConfig.offline;

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
        <DialogContent className="max-w-5xl w-full bg-white rounded-2xl p-0 overflow-hidden">

          {/* ── Modal Header ── */}
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-slate-100">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">
                <TbShirt className="text-slate-600 text-lg" />
              </div>
              <div className="flex-1 min-w-0">
                <DialogTitle className="text-slate-900 text-base font-semibold">
                  {vestId} — Personnel History
                </DialogTitle>
                <p className="text-slate-400 text-xs mt-0.5">
                  All users assigned to this vest · click <strong>Mark Return</strong> when the vest is handed back
                </p>
              </div>
              {/* Live status + sensor log button */}
              <div className="flex items-center gap-2 shrink-0">
                {liveVest && (
                  <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", sc.className)}>
                    <span className={cn("h-1.5 w-1.5 rounded-full", sc.dot)} />
                    {sc.label}
                  </span>
                )}
                <Button size="sm" variant="outline"
                  onClick={() => setSensorLogOpen(true)}
                  className="rounded-lg border-slate-200 text-slate-600 hover:text-slate-900 text-xs h-7 px-3 gap-1">
                  <FiEye className="text-xs" /> Sensor Log
                </Button>
              </div>
            </div>
          </DialogHeader>

          {/* ── Mini live sensor strip ── */}
          {liveVest && (
            <div className="px-6 py-3 border-b border-slate-100 grid grid-cols-5 gap-3">
              {([
                { label: "Temp",    value: `${liveVest.temp.toFixed(1)} °C`,    warn: liveVest.temp  > THRESHOLDS.temp },
                { label: "Humidity",value: `${liveVest.humidity.toFixed(1)} %`, warn: false },
                { label: "Dust",    value: `${liveVest.dust.toFixed(1)} µg/m³`, warn: liveVest.dust  > THRESHOLDS.dust },
                { label: "AQI",     value: liveVest.aqi.toFixed(0),             warn: liveVest.aqi   > THRESHOLDS.aqi },
                { label: "CO Gas",  value: `${liveVest.coGas.toFixed(2)} ppm`,  warn: liveVest.coGas > THRESHOLDS.coGas },
              ] as const).map(({ label, value, warn }) => (
                <div key={label} className={cn("rounded-xl border px-3 py-2 text-center", warn ? "border-red-100 bg-red-50" : "border-slate-100 bg-slate-50")}>
                  <p className={cn("text-xs uppercase tracking-widest mb-0.5", warn ? "text-red-400" : "text-slate-400")}>{label}</p>
                  <p className={cn("text-sm font-bold tabular-nums", warn ? "text-red-600" : "text-slate-800")}>{value}</p>
                </div>
              ))}
            </div>
          )}

          {/* ── Personnel history table ── */}
          <div className="overflow-auto max-h-[50vh] px-6 py-4">
            {loading ? (
              <div className="flex items-center justify-center py-16 gap-2 text-slate-400">
                <FiLoader className="animate-spin text-lg" />
                <span className="text-sm">Loading personnel records…</span>
              </div>
            ) : records.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2">
                <FiUser className="text-3xl text-slate-300" />
                <p className="text-slate-400 text-sm">No personnel assigned to this vest yet.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-100 hover:bg-transparent bg-slate-50">
                    {["#", "Name", "Age", "Department", "Assigned Vest", "Assigned At", "Returned At", "Status", "IsReturn"].map((h) => (
                      <TableHead key={h} className="text-slate-500 text-xs uppercase tracking-wider font-semibold whitespace-nowrap">{h}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((record, i) => {
                    const isActive    = !record.isReturned;
                    const isReturning = returningId === record.docId;
                    return (
                      <TableRow
                        key={record.docId}
                        className={cn(
                          "border-slate-100 transition-colors",
                          isActive ? "bg-blue-50/60 hover:bg-blue-50" : "hover:bg-slate-50"
                        )}
                      >
                        {/* # */}
                        <TableCell className="text-slate-400 text-xs font-mono">{i + 1}</TableCell>

                        {/* Name */}
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className={cn(
                              "h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
                              isActive ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-500"
                            )}>
                              {record.name.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <p className={cn("text-sm font-semibold leading-tight", isActive ? "text-blue-800" : "text-slate-700")}>
                                {record.name}
                              </p>
                              {isActive && <p className="text-blue-400 text-xs">Current user</p>}
                            </div>
                          </div>
                        </TableCell>

                        {/* Age */}
                        <TableCell className="text-slate-500 text-sm">{record.age ?? "—"}</TableCell>

                        {/* Department */}
                        <TableCell className="text-slate-500 text-sm">{record.department}</TableCell>

                        {/* Assigned Vest */}
                        <TableCell>
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 bg-slate-100 rounded-full px-2.5 py-0.5">
                            <TbShirt className="text-slate-400 text-sm" />{record.assignedVest}
                          </span>
                        </TableCell>

                        {/* Assigned At */}
                        <TableCell className="text-slate-400 font-mono text-xs whitespace-nowrap">
                          {formatTs(record.registeredAt)}
                        </TableCell>

                        {/* Returned At */}
                        <TableCell className="text-slate-400 font-mono text-xs whitespace-nowrap">
                          {record.isReturned ? formatTs(record.returnedAt) : "—"}
                        </TableCell>

                        {/* Status badge */}
                        <TableCell><ReturnBadge returned={record.isReturned} /></TableCell>

                        {/* IsReturn action */}
                        <TableCell>
                          {isActive ? (
                            <Button
                              size="sm"
                              onClick={() => handleReturn(record)}
                              disabled={isReturning}
                              className={cn(
                                "rounded-lg text-xs h-7 px-3 gap-1.5 font-semibold transition-all",
                                isReturning
                                  ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                                  : "bg-amber-500 hover:bg-amber-600 text-white"
                              )}
                            >
                              {isReturning
                                ? <><FiLoader className="animate-spin text-xs" /> Returning…</>
                                : <><FiRotateCcw className="text-xs" /> Mark Return</>}
                            </Button>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-slate-400 font-medium">
                              <FiCheck className="text-emerald-500" /> Done
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>

          {/* ── Footer ── */}
          {!loading && records.length > 0 && (
            <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between">
              <p className="text-slate-400 text-xs">
                {records.length} assignment{records.length !== 1 ? "s" : ""} total
                {activeUser && (
                  <span className="ml-2 text-blue-500 font-medium">· {activeUser.name} currently in use</span>
                )}
              </p>
              <Button size="sm" variant="outline" onClick={onClose} className="rounded-xl border-slate-200 text-slate-600 text-xs h-7 px-4">
                Close
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Nested sensor log modal */}
      <EventLogModal
        open={sensorLogOpen}
        onClose={() => setSensorLogOpen(false)}
        vestId={vestId}
        activeUserName={activeUser?.name ?? null}
      />
    </>
  );
}

// ─── Registered Users Table ─────────────────────────────────────────
// Pulls all unique people from `registeredPersonnel`.
// Shows their current vest status and lets unassigned users pick an available vest.

function RegisteredUsersTable({
  activeUserMap,
  onAssignSuccess,
}: {
  activeUserMap:   Record<string, PersonnelRecord | null>;
  onAssignSuccess: () => void;
}) {
  const [users, setUsers]               = useState<UniqueUser[]>([]);
  const [loading, setLoading]           = useState(true);
  const [selectedVest, setSelectedVest] = useState<Record<string, string>>({});
  const [assigningId, setAssigningId]   = useState<string | null>(null);

  // Re-fetch users whenever activeUserMap changes so Vest Type column
  // reflects the latest assignment/return state.
  // We derive a stable string key from just the vest→name mapping.
  const activeMapKey = VEST_KEYS.map((k) => `${k}:${activeUserMap[k]?.name ?? ""}`).join("|");

  useEffect(() => {
    fetchUniqueUsers().then((data) => {
      setUsers(data);
      setLoading(false);
    });
  }, [activeMapKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Vests that are currently free (null = fetched, confirmed no active user)
  const availableVests = VEST_KEYS.filter((k) => activeUserMap[k] === null);

  async function handleAssign(user: UniqueUser) {
    const vestId = selectedVest[user.key];
    if (!vestId) return;
    setAssigningId(user.key);
    try {
      // 1. Write the new assignment to Firestore
      await assignUserToVest(user, vestId);
      // 2. Clear the row's vest picker
      setSelectedVest((prev) => { const n = { ...prev }; delete n[user.key]; return n; });
      // 3. Tell the parent to refresh activeUserMap for ALL vests —
      //    this updates the Live Sensor strip, Registered Vests table,
      //    and re-triggers the useEffect above to refresh this table too.
      onAssignSuccess();
    } catch (err) {
      console.error("Assign error:", err);
    } finally {
      setAssigningId(null);
    }
  }

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-slate-800 text-base font-semibold tracking-wide flex items-center gap-2">
          <FiUsers className="text-lg text-indigo-500" />
          Registered Users
          {!loading && (
            <span className="ml-1 inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold">
              {users.length}
            </span>
          )}
        </h2>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-slate-100 hover:bg-transparent bg-slate-50">
              {[
                { label: "#",          icon: FiHash },
                { label: "Name",       icon: FiUser },
                { label: "Department", icon: FiBriefcase },
                { label: "Vest Type",  icon: TbShirt },
                { label: "Assign",     icon: FiCheck },
              ].map(({ label, icon: Icon }) => (
                <TableHead key={label} className="text-slate-500 text-xs uppercase tracking-wider font-semibold whitespace-nowrap">
                  <div className="flex items-center gap-1.5">
                    <Icon className="text-slate-400 text-sm" />{label}
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-10">
                  <div className="flex items-center justify-center gap-2 text-slate-400">
                    <FiLoader className="animate-spin" />
                    <span className="text-sm">Loading users…</span>
                  </div>
                </TableCell>
              </TableRow>
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-10">
                  <div className="flex flex-col items-center gap-1.5">
                    <FiUsers className="text-2xl text-slate-300" />
                    <p className="text-slate-400 text-sm">No users registered yet.</p>
                    <p className="text-slate-300 text-xs">Use “Register New Device” above to add someone.</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              users.map((user, i) => {
                const isAssigning = assigningId === user.key;
                const rowVest     = selectedVest[user.key] ?? "";

                // Check if this person currently holds an active vest
                // by matching against activeUserMap values
                const activeEntry = Object.values(activeUserMap).find(
                  (r) => r && r.name === user.name && r.department === user.department
                );
                const hasVest  = !!activeEntry;
                const canAssign = !hasVest && !!rowVest && !isAssigning;

                return (
                  <TableRow
                    key={user.key}
                    className={cn(
                      "border-slate-100 transition-colors",
                      hasVest ? "bg-emerald-50/40 hover:bg-emerald-50/70" : "hover:bg-slate-50"
                    )}
                  >
                    {/* # */}
                    <TableCell className="text-slate-400 font-mono text-xs w-10">{i + 1}</TableCell>

                    {/* Name */}
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className={cn(
                          "h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
                          hasVest ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
                        )}>
                          {user.name.charAt(0).toUpperCase()}
                        </div>
                        <p className={cn("text-sm font-semibold", hasVest ? "text-emerald-800" : "text-slate-800")}>
                          {user.name}
                        </p>
                      </div>
                    </TableCell>

                    {/* Department */}
                    <TableCell className="text-slate-500 text-sm">{user.department}</TableCell>

                    {/* Vest Type */}
                    <TableCell>
                      {hasVest ? (
                        // Currently using a vest — show which one
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-0.5">
                          <TbShirt className="text-emerald-500 text-sm shrink-0" />
                          {activeEntry!.assignedVest}
                          <span className="text-emerald-400 font-normal">· In Use</span>
                        </span>
                      ) : availableVests.length === 0 ? (
                        // All vests occupied
                        <span className="inline-flex items-center gap-1.5 text-xs text-slate-400 italic">
                          <TbShirt className="text-slate-300 text-sm" />
                          No vest available
                        </span>
                      ) : (
                        // Show picker of free vests
                        <Select
                          value={rowVest}
                          onValueChange={(v) =>
                            setSelectedVest((prev) => ({ ...prev, [user.key]: v }))
                          }
                        >
                          <SelectTrigger className="w-40 h-7 text-xs rounded-lg border-slate-200 bg-slate-50 text-slate-700">
                            <SelectValue placeholder="Select vest…" />
                          </SelectTrigger>
                          <SelectContent className="bg-white border-slate-200 text-slate-800">
                            {availableVests.map((v) => (
                              <SelectItem key={v} value={v}>
                                <span className="flex items-center gap-2">
                                  <TbShirt className="text-emerald-500" />
                                  {v}
                                  <span className="text-emerald-500 text-xs font-medium">(Available)</span>
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>

                    {/* Assign */}
                    <TableCell>
                      {hasVest ? (
                        <span className="inline-flex items-center gap-1 text-xs text-slate-400">
                          <FiCheck className="text-emerald-500" /> Assigned
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => handleAssign(user)}
                          disabled={!canAssign}
                          className={cn(
                            "rounded-lg text-xs h-7 px-3 gap-1.5 font-semibold transition-all",
                            isAssigning
                              ? "bg-indigo-100 text-indigo-400 cursor-not-allowed"
                              : !rowVest
                                ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                                : "bg-indigo-600 hover:bg-indigo-700 text-white"
                          )}
                        >
                          {isAssigning
                            ? <><FiLoader className="animate-spin text-xs" /> Assigning…</>
                            : <><TbShirt className="text-xs" /> Assign</>
                          }
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─── Vest Table Columns ───────────────────────────────────────────────────────

const vestColumns: { label: string; icon: React.ElementType }[] = [
  { label: "Vest Name",    icon: TbShirt },
  { label: "RFID Tag",     icon: RiRfidLine },
  { label: "Current User", icon: FiUser },
  { label: "Department",   icon: FiBriefcase },
  { label: "Status",       icon: FiActivity },
  { label: "IsZoneA",      icon: FiMapPin },
  { label: "IsZoneB",      icon: FiMapPin },
  { label: "Dust",         icon: TbWind },
  { label: "CO Gas",       icon: GiGasMask },
  { label: "AQI",          icon: GiGasMask },
  { label: "Temp",         icon: BsThermometerHalf },
  { label: "Humidity",     icon: BsDroplet },
  { label: "Action",       icon: FiEye },
];

// ─── Main Component ───────────────────────────────────────────────────────────

export default function SaVestDashboard() {
  const [vests, setVests]             = useState<Vest[]>([]);
  const [alerts, setAlerts]           = useState<AlertLog[]>([]);
  const [sheetOpen, setSheetOpen]     = useState(false);
  const [form, setForm]               = useState<RegisterForm>(FORM_EMPTY);
  const [formErrors, setFormErrors]   = useState<Partial<RegisterForm>>({});
  const [saving, setSaving]           = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [selectedVest, setSelectedVest] = useState<VestKey>("Vest1");

  /**
   * activeUserMap — keyed by vestId.
   * Holds the single active (isReturned=false) user for each vest.
   * undefined = not fetched yet, null = no active user.
   */
  const [activeUserMap, setActiveUserMap]       = useState<Record<string, PersonnelRecord | null>>({});
  const [personnelLoading, setPersonnelLoading] = useState(false);

  // Which vest's history modal is open
  const [historyModalVest, setHistoryModalVest] = useState<string | null>(null);

  const lastAlertRef = useRef<Record<string, string | null>>({});

  // ── Load / refresh active user for one vest ──
  // force=true always re-queries Firestore, bypassing the "already loaded" guard
  async function loadActiveUser(vestKey: string, force = false) {
    if (!force && activeUserMap[vestKey] !== undefined) return;
    const record = await fetchActiveUser(vestKey);
    setActiveUserMap((prev) => ({ ...prev, [vestKey]: record }));
  }

  // Convenience: force-refresh ALL vests at once (called after any assign/return)
  async function refreshAllActiveUsers() {
    const results = await Promise.all(
      VEST_KEYS.map(async (k) => ({ k, record: await fetchActiveUser(k) }))
    );
    setActiveUserMap((prev) => {
      const next = { ...prev };
      results.forEach(({ k, record }) => { next[k] = record; });
      return next;
    });
  }

  // ── Realtime DB: vest sensor listeners ──
  useEffect(() => {
    const unsubs: (() => void)[] = [];
    VEST_KEYS.forEach((vestKey, index) => {
      const unsub = onValue(ref(database, `monitoring/${vestKey}`), (snap) => {
        const raw = snap.val() as RawVestData | null;
        setVests((prev) => {
          const updated = [...prev];
          const idx     = updated.findIndex((v) => v.id === vestKey);

          if (!raw) {
            const offline: Vest = { id: vestKey, name: vestKey, rfidTag: VEST_META[vestKey].rfidTag, status: "offline", zoneA: false, zoneB: false, temp: 0, humidity: 0, dust: 0, aqi: 0, coGas: 0 };
            idx >= 0 ? (updated[idx] = offline) : updated.splice(index, 0, offline);
            return updated;
          }

          const sensors = parseVestData(raw);
          const status  = deriveStatus(sensors);
          const record: Vest  = { id: vestKey, name: vestKey, rfidTag: VEST_META[vestKey].rfidTag, status, zoneA: sensors.zoneA, zoneB: sensors.zoneB, temp: sensors.temp, humidity: sensors.humidity, dust: sensors.dust, aqi: sensors.aqi, coGas: sensors.coGas };
          idx >= 0 ? (updated[idx] = record) : updated.splice(index, 0, record);

          // Persist snapshot to Firestore
          saveEventLog(vestKey, { timestamp: new Date().toISOString(), temp: sensors.temp, humidity: sensors.humidity, dust: sensors.dust, aqi: sensors.aqi, coGas: sensors.coGas, status, zoneA: sensors.zoneA, zoneB: sensors.zoneB });

          // Push alert if threshold crossed
          const alertType = deriveAlertType(sensors);
          if (alertType && alertType !== lastAlertRef.current[vestKey]) {
            lastAlertRef.current[vestKey] = alertType;
            push(ref(database, "alerts"), { timestamp: new Date().toISOString().replace("T", " ").slice(0, 19), vest: vestKey, alertType, zoneA: sensors.zoneA, zoneB: sensors.zoneB, dust: sensors.dust, coGas: sensors.coGas, aqi: sensors.aqi, temp: sensors.temp, humidity: sensors.humidity });
          }
          if (!alertType && lastAlertRef.current[vestKey]) lastAlertRef.current[vestKey] = null;

          return updated;
        });
      });
      unsubs.push(unsub);
    });
    return () => unsubs.forEach((u) => u());
  }, []);

  // ── Realtime DB: alert log listener ──
  useEffect(() => {
    const unsub = onValue(ref(database, "alerts"), (snap) => {
      const data = snap.val();
      if (!data) { setAlerts([]); return; }
      setAlerts((Object.values(data) as AlertLog[]).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)));
    });
    return () => unsub();
  }, []);

  // ── Pre-fetch active users for all vests on mount ──
  useEffect(() => {
    setPersonnelLoading(true);
    Promise.all(VEST_KEYS.map((k) => loadActiveUser(k))).finally(() => setPersonnelLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Refresh for selectedVest when strip vest picker changes ──
  useEffect(() => { loadActiveUser(selectedVest); /* eslint-disable-next-line */ }, [selectedVest]);

  const totalVests  = vests.length;
  const onlineCount = vests.filter((v) => v.status === "online").length;
  const alertCount  = vests.filter((v) => v.status === "alert").length;
  const rescueCount = vests.filter((v) => v.status === "rescue").length;
  const activeVest  = vests.find((v) => v.id === selectedVest);
  const activeUser  = activeUserMap[selectedVest];

  const setField = (field: keyof RegisterForm) => (value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  function validateForm(): boolean {
    const errors: Partial<RegisterForm> = {};
    if (!form.name.trim())  errors.name         = "Name is required.";
    if (!form.age.trim())   errors.age          = "Age is required.";
    else if (isNaN(Number(form.age)) || Number(form.age) < 1 || Number(form.age) > 120)
                            errors.age          = "Enter a valid age (1–120).";
    if (!form.department)   errors.department   = "Department is required.";
    if (!form.assignedVest) errors.assignedVest = "Please select a vest.";
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleRegister() {
    if (!validateForm()) return;
    setSaving(true);
    try {
      await addDoc(collection(firestore, "registeredPersonnel"), {
        name:         form.name.trim(),
        age:          Number(form.age),
        department:   form.department,
        assignedVest: form.assignedVest,
        registeredAt: serverTimestamp(),
        isReturned:   false,   // ← new field
        returnedAt:   null,    // ← new field
      });
      await loadActiveUser(form.assignedVest, true);
      setSaveSuccess(true);
      setTimeout(() => { setSaveSuccess(false); setSheetOpen(false); setForm(FORM_EMPTY); setFormErrors({}); }, 1500);
    } catch (err) {
      console.error("Firestore error:", err);
    } finally { setSaving(false); }
  }

  function handleSheetOpenChange(open: boolean) {
    setSheetOpen(open);
    if (!open) { setForm(FORM_EMPTY); setFormErrors({}); setSaveSuccess(false); }
  }

  // Called by VestHistoryModal after a return is marked
  function handleReturnSuccess(vestId: string) {
    refreshAllActiveUsers();
  }

  return (
    <div className="min-h-screen w-full bg-slate-50 px-4 py-10">
      <div className="max-w-6xl mx-auto flex flex-col gap-8">

        {/* ── HEADER ── */}
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-slate-900 text-2xl font-bold tracking-tight">SaVest</h1>
            <p className="text-slate-400 text-xs tracking-widest uppercase">Main System Dashboard</p>
          </div>
          <div className="ml-auto flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-emerald-600 text-xs font-semibold uppercase tracking-widest">Live</span>
          </div>
        </div>

        {/* ── LIVE SENSOR STRIP ── */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-slate-500 text-xs uppercase tracking-widest font-semibold">Live Readings — {selectedVest}</p>
            <Select value={selectedVest} onValueChange={(v) => setSelectedVest(v as VestKey)}>
              <SelectTrigger className="w-32 h-7 text-xs rounded-lg border-slate-200 bg-slate-50 text-slate-700"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-white border-slate-200 text-slate-800">
                {VEST_KEYS.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {/* Active user banner */}
          <div className={cn(
            "mb-3 rounded-xl border px-4 py-3 flex items-center gap-4 transition-colors",
            personnelLoading ? "border-slate-100 bg-slate-50" : activeUser ? "border-blue-100 bg-blue-50" : "border-slate-100 bg-slate-50"
          )}>
            <div className={cn("h-10 w-10 rounded-full flex items-center justify-center shrink-0 text-lg font-bold", activeUser ? "bg-blue-100 text-blue-600" : "bg-slate-100 text-slate-400")}>
              {personnelLoading ? <FiLoader className="animate-spin text-slate-400" /> : activeUser ? activeUser.name.charAt(0).toUpperCase() : <FiUser />}
            </div>
            <div className="flex-1 min-w-0">
              {personnelLoading ? (
                <p className="text-slate-400 text-sm">Loading personnel…</p>
              ) : activeUser ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
                  <div className="flex items-center gap-1.5"><FiUser className="text-blue-400 text-xs shrink-0" /><span className="text-slate-800 text-sm font-semibold">{activeUser.name}</span></div>
                  <div className="flex items-center gap-1.5"><FiBriefcase className="text-blue-400 text-xs shrink-0" /><span className="text-slate-500 text-sm">{activeUser.department}</span></div>
                  <div className="flex items-center gap-1.5"><TbShirt className="text-blue-400 text-xs shrink-0" /><span className="text-slate-500 text-sm">{activeUser.assignedVest}</span></div>
                </div>
              ) : (
                <p className="text-slate-400 text-sm italic">No personnel registered to {selectedVest}</p>
              )}
            </div>
            {activeVest && (
              <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium shrink-0", statusConfig[activeVest.status].className)}>
                <span className={cn("h-1.5 w-1.5 rounded-full", statusConfig[activeVest.status].dot)} />
                {statusConfig[activeVest.status].label}
              </span>
            )}
          </div>

          {/* Sensor cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {([
              { label: "Dust",   value: (activeVest?.dust  ?? 0).toFixed(1), unit: "µg/m³", Icon: TbWind,            warn: (activeVest?.dust  ?? 0) > THRESHOLDS.dust },
              { label: "CO Gas", value: (activeVest?.coGas ?? 0).toFixed(2), unit: "ppm",   Icon: GiGasMask,         warn: (activeVest?.coGas ?? 0) > THRESHOLDS.coGas },
              { label: "AQI",    value: (activeVest?.aqi   ?? 0).toFixed(0), unit: "",      Icon: GiGasMask,         warn: (activeVest?.aqi   ?? 0) > THRESHOLDS.aqi },
              { label: "Temp",   value: (activeVest?.temp  ?? 0).toFixed(1), unit: "°C",    Icon: BsThermometerHalf, warn: (activeVest?.temp  ?? 0) > THRESHOLDS.temp },
            ] as const).map(({ label, value, unit, Icon, warn }) => (
              <div key={label} className={cn("rounded-xl border px-4 py-3 flex items-center gap-3 transition-colors", warn ? "border-red-200 bg-red-50" : "border-slate-100 bg-slate-50")}>
                <Icon className={cn("text-lg shrink-0", warn ? "text-red-500" : "text-slate-400")} />
                <div className="flex-1 min-w-0">
                  <p className={cn("text-xs uppercase tracking-widest", warn ? "text-red-400" : "text-slate-400")}>{label}</p>
                  <p className={cn("text-lg font-bold tabular-nums leading-tight", warn ? "text-red-600" : "text-slate-800")}>
                    {value}<span className="text-xs font-normal ml-0.5 text-slate-400">{unit}</span>
                  </p>
                </div>
                {warn && <MdOutlineWarningAmber className="text-red-500 text-lg shrink-0 animate-pulse" />}
              </div>
            ))}
          </div>
        </div>

        {/* ── STAT CARDS ── */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Total Vests" value={totalVests}  icon={TbShirt}              iconColor="text-blue-600"    iconBg="bg-blue-50"    valueColor="text-blue-600"    borderColor="border-blue-100"    />
          <StatCard label="Online"      value={onlineCount} icon={HiOutlineStatusOnline} iconColor="text-emerald-600" iconBg="bg-emerald-50" valueColor="text-emerald-600" borderColor="border-emerald-100" />
          <StatCard label="Alerts"      value={alertCount}  icon={MdOutlineWarningAmber} iconColor="text-amber-600"  iconBg="bg-amber-50"   valueColor="text-amber-600"   borderColor="border-amber-100"   />
          <StatCard label="Need Rescue" value={rescueCount} icon={MdOutlineSos}          iconColor="text-red-600"    iconBg="bg-red-50"     valueColor="text-red-600"     borderColor="border-red-100"     />
        </div>

        {/* ── REGISTER NEW DEVICE ── */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-6 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-slate-800 font-semibold text-base flex items-center gap-2">
              <RiRfidLine className="text-blue-500 text-lg" /> Register New Device
            </h2>
            <p className="text-slate-400 text-sm mt-0.5">Assign a vest to a personnel and save their information.</p>
          </div>
          <Button onClick={() => setSheetOpen(true)} className="bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl px-6 gap-2 shrink-0">
            <FiPlus className="text-base" /> Register
          </Button>
        </div>

        {/* ── REGISTER SHEET ── */}
        <Sheet open={sheetOpen} onOpenChange={handleSheetOpenChange}>
          <SheetContent className="w-full sm:max-w-md bg-white flex flex-col gap-0 p-0">
            <SheetHeader className="px-6 pt-6 pb-4 border-b border-slate-100">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-xl bg-blue-50 flex items-center justify-center">
                  <RiRfidLine className="text-blue-600 text-lg" />
                </div>
                <div>
                  <SheetTitle className="text-slate-900 text-base font-semibold">Register New Device</SheetTitle>
                  <SheetDescription className="text-slate-400 text-xs mt-0.5">Fill in the person's details and select their assigned vest.</SheetDescription>
                </div>
              </div>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-5">
              <FormField label="Full Name" icon={FiUser} error={formErrors.name}>
                <Input placeholder="e.g. Juan dela Cruz" value={form.name} onChange={(e) => setField("name")(e.target.value)}
                  className={cn("rounded-xl border-slate-200 bg-slate-50 text-slate-800 placeholder:text-slate-400 focus-visible:ring-blue-500", formErrors.name && "border-red-300 bg-red-50")} />
              </FormField>
              <FormField label="Age" icon={FiHash} error={formErrors.age}>
                <Input type="number" min={1} max={120} placeholder="e.g. 32" value={form.age} onChange={(e) => setField("age")(e.target.value)}
                  className={cn("rounded-xl border-slate-200 bg-slate-50 text-slate-800 placeholder:text-slate-400 focus-visible:ring-blue-500", formErrors.age && "border-red-300 bg-red-50")} />
              </FormField>
              <FormField label="Department" icon={FiBriefcase} error={formErrors.department}>
                <Select value={form.department} onValueChange={setField("department")}>
                  <SelectTrigger className={cn("rounded-xl border-slate-200 bg-slate-50 text-slate-800 focus:ring-blue-500", formErrors.department && "border-red-300 bg-red-50")}>
                    <SelectValue placeholder="Select department" />
                  </SelectTrigger>
                  <SelectContent className="bg-white border-slate-200 text-slate-800">
                    {DEPARTMENTS.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Assign Vest #" icon={TbShirt} error={formErrors.assignedVest}>
                <Select value={form.assignedVest} onValueChange={setField("assignedVest")}>
                  <SelectTrigger className={cn("rounded-xl border-slate-200 bg-slate-50 text-slate-800 focus:ring-blue-500", formErrors.assignedVest && "border-red-300 bg-red-50")}>
                    <SelectValue placeholder="Select vest" />
                  </SelectTrigger>
                  <SelectContent className="bg-white border-slate-200 text-slate-800">
                    {VEST_KEYS.map((v) => (
                      <SelectItem key={v} value={v}>
                        <span className="flex items-center gap-2"><TbShirt className="text-slate-400" />{v}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              {form.name && form.assignedVest && (
                <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 flex flex-col gap-1">
                  <p className="text-blue-700 text-xs font-semibold uppercase tracking-widest mb-1">Preview</p>
                  <p className="text-slate-700 text-sm"><span className="text-slate-400">Name:</span> {form.name}</p>
                  {form.age        && <p className="text-slate-700 text-sm"><span className="text-slate-400">Age:</span> {form.age}</p>}
                  {form.department && <p className="text-slate-700 text-sm"><span className="text-slate-400">Dept:</span> {form.department}</p>}
                  <p className="text-slate-700 text-sm"><span className="text-slate-400">Vest:</span> {form.assignedVest}</p>
                </div>
              )}
            </div>

            <SheetFooter className="px-6 py-4 border-t border-slate-100 flex gap-3">
              <Button variant="outline" onClick={() => handleSheetOpenChange(false)}
                className="flex-1 rounded-xl border-slate-200 text-slate-600 hover:text-slate-900 gap-2">
                <FiX className="text-base" /> Cancel
              </Button>
              <Button onClick={handleRegister} disabled={saving || saveSuccess}
                className={cn("flex-1 rounded-xl font-semibold gap-2 transition-all",
                  saveSuccess ? "bg-emerald-500 hover:bg-emerald-500 text-white" : "bg-blue-600 hover:bg-blue-700 text-white")}>
                {saveSuccess ? <><FiCheck className="text-base" /> Saved!</>
                  : saving    ? <><FiLoader className="text-base animate-spin" /> Saving…</>
                  :             <><RiRfidLine className="text-base" /> Register</>}
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>

        {/* ── REGISTERED VESTS TABLE ── */}
        <div>
          <SectionHeader icon={FiClipboard} label="Registered Vests" iconColor="text-slate-500" />
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-slate-100 hover:bg-transparent bg-slate-50">
                  {vestColumns.map(({ label, icon: Icon }) => (
                    <TableHead key={label} className="text-slate-500 text-xs uppercase tracking-wider font-semibold whitespace-nowrap">
                      <div className="flex items-center gap-1.5"><Icon className="text-slate-400 text-sm" />{label}</div>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {vests.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={vestColumns.length} className="text-center text-slate-400 py-10">Connecting to Firebase…</TableCell>
                  </TableRow>
                ) : (
                  vests.map((vest) => {
                    const sc          = statusConfig[vest.status];
                    const currentUser = activeUserMap[vest.id];
                    return (
                      <TableRow key={vest.id} className="border-slate-100 hover:bg-slate-50 transition-colors">
                        <TableCell className="text-slate-800 font-semibold">{vest.name}</TableCell>
                        <TableCell className="text-slate-500 font-mono text-xs">{vest.rfidTag}</TableCell>

                        {/* Current User */}
                        <TableCell>
                          {currentUser === undefined ? (
                            <span className="text-slate-300 italic text-xs">…</span>
                          ) : currentUser ? (
                            <div className="flex items-center gap-2">
                              <div className="h-6 w-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold shrink-0">
                                {currentUser.name.charAt(0).toUpperCase()}
                              </div>
                              <span className="text-slate-700 text-sm font-medium">{currentUser.name}</span>
                            </div>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-slate-400 italic">
                              <FiUser className="text-slate-300" /> Unassigned
                            </span>
                          )}
                        </TableCell>

                        {/* Department */}
                        <TableCell className="text-slate-500 text-sm">
                          {currentUser === undefined ? <span className="text-slate-300 italic text-xs">…</span>
                            : currentUser ? currentUser.department
                            : <span className="text-slate-300 italic text-xs">—</span>}
                        </TableCell>

                        {/* Status */}
                        <TableCell>
                          <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", sc.className)}>
                            <span className={cn("h-1.5 w-1.5 rounded-full", sc.dot)} />{sc.label}
                          </span>
                        </TableCell>

                        <TableCell><ZoneBadge active={vest.zoneA} /></TableCell>
                        <TableCell><ZoneBadge active={vest.zoneB} /></TableCell>
                        <TableCell className={cn("font-mono text-sm font-semibold", vest.dust  > THRESHOLDS.dust  ? "text-red-500"   : "text-emerald-600")}>{vest.dust.toFixed(1)}</TableCell>
                        <TableCell className={cn("font-mono text-sm font-semibold", vest.coGas > THRESHOLDS.coGas ? "text-amber-500" : "text-emerald-600")}>{vest.coGas.toFixed(2)}</TableCell>
                        <TableCell className={cn("font-mono text-sm font-semibold", vest.aqi   > THRESHOLDS.aqi   ? "text-amber-500" : "text-emerald-600")}>{vest.aqi.toFixed(0)}</TableCell>
                        <TableCell className={cn("font-mono text-sm font-semibold", vest.temp  > THRESHOLDS.temp  ? "text-red-500"   : "text-blue-500"  )}>{vest.temp.toFixed(1)}°C</TableCell>
                        <TableCell className="text-purple-600 font-mono text-sm font-semibold">{vest.humidity.toFixed(1)}%</TableCell>

                        {/* View — opens the full history + IsReturn modal */}
                        <TableCell>
                          <Button size="sm" variant="outline"
                            onClick={() => setHistoryModalVest(vest.id)}
                            className="rounded-lg border-slate-200 bg-white text-slate-600 hover:text-slate-900 hover:border-slate-300 text-xs h-7 px-3 gap-1">
                            <FiEye className="text-xs" /> View
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* ── REGISTERED USERS TABLE ── */}
        <RegisteredUsersTable
          activeUserMap={activeUserMap}
          onAssignSuccess={() => refreshAllActiveUsers()}
        />

        {/* ── ALERT LOGS ── */}
        <div>
          <SectionHeader icon={LuAlarmClock} label="Alert Logs" iconColor="text-orange-500" badge={alerts.length} />
          <div className="rounded-2xl border border-orange-100 bg-white shadow-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-orange-100 hover:bg-transparent bg-orange-50">
                  {["Timestamp", "Vest", "Alert Type", "IsZoneA", "IsZoneB", "Dust", "CO Gas", "AQI", "Temp", "Humidity"].map((h) => (
                    <TableHead key={h} className="text-orange-600 text-xs uppercase tracking-wider font-semibold">{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-slate-400 py-10">
                      No alerts yet — they appear automatically when sensor thresholds are exceeded.
                    </TableCell>
                  </TableRow>
                ) : (
                  alerts.map((log, i) => (
                    <TableRow key={i} className="border-orange-50 hover:bg-orange-50/60 transition-colors">
                      <TableCell className="text-slate-400 font-mono text-xs">{log.timestamp}</TableCell>
                      <TableCell className="text-slate-800 font-semibold">{log.vest}</TableCell>
                      <TableCell>
                        <Badge className={cn(
                          "rounded-full text-xs font-medium border inline-flex items-center gap-1",
                          log.alertType === "Need Rescue" ? "border-red-200 bg-red-50 text-red-700" : "border-amber-200 bg-amber-50 text-amber-700"
                        )}>
                          {log.alertType === "Need Rescue" ? <MdOutlineSos className="text-sm" /> : <MdOutlineWarningAmber className="text-sm" />}
                          {log.alertType}
                        </Badge>
                      </TableCell>
                      <TableCell><ZoneBadge active={log.zoneA} /></TableCell>
                      <TableCell><ZoneBadge active={log.zoneB} /></TableCell>
                      <TableCell className={cn("font-mono text-sm font-semibold", log.dust  > THRESHOLDS.dust  ? "text-red-500"   : "text-slate-600")}>{log.dust}</TableCell>
                      <TableCell className={cn("font-mono text-sm font-semibold", log.coGas > THRESHOLDS.coGas ? "text-amber-500" : "text-slate-600")}>{log.coGas}</TableCell>
                      <TableCell className={cn("font-mono text-sm font-semibold", log.aqi   > THRESHOLDS.aqi   ? "text-amber-500" : "text-slate-600")}>{log.aqi}</TableCell>
                      <TableCell className={cn("font-mono text-sm font-semibold", log.temp  > THRESHOLDS.temp  ? "text-red-500"   : "text-slate-600")}>{log.temp}°C</TableCell>
                      <TableCell className="text-purple-600 font-mono text-sm font-semibold">{log.humidity}%</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>

      </div>

      {/* ── VEST HISTORY MODAL (contains IsReturn column + nested sensor log) ── */}
      {historyModalVest && (
        <VestHistoryModal
          open={!!historyModalVest}
          onClose={() => setHistoryModalVest(null)}
          vestId={historyModalVest}
          liveVest={vests.find((v) => v.id === historyModalVest)}
          onReturnSuccess={handleReturnSuccess}
        />
      )}
    </div>
  );
}