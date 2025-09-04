import React, { useEffect, useMemo, useState } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getFirestore, collection, addDoc, updateDoc, deleteDoc, doc,
  onSnapshot, getDocs, getDoc, writeBatch
} from 'firebase/firestore';

import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
// Firebase Storage (para comprobantes de pago)
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from 'firebase/storage';

// ---------- utilidades ----------
const uid = () => (crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
// Normaliza a 'YYYY-MM-DD' SIN UTC
const toISODate = (d) => {
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const dt = (d instanceof Date) ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
// Normaliza 'dateISO' desde posibles tipos (string 'YYYY-MM-DD', Date, Firestore Timestamp, number)
const normYMD = (v) => {
  if (!v) return '';
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    // Si es ISO completo, recorta a YYYY-MM-DD en zona local
    const dt = new Date(v);
    return toISODate(dt);
  }
  // Firestore Timestamp
  if (typeof v === 'object' && typeof v.toDate === 'function') {
    return toISODate(v.toDate());
  }
  // epoch number
  if (typeof v === 'number') {
    return toISODate(new Date(v));
  }
  // Date u otros
  try {
    return toISODate(new Date(v));
  } catch {
    return '';
  }
};
const formatTime = (t) => t.padStart(5, '0');
// Compara strings 'YYYY-MM-DD'
const sameDay = (a, b) => !!a && !!b && a === b;
const fmtCOP = (n) => n?.toLocaleString('es-CO');

const fmtDateLongEs = (isoYmd) => {
  if (!isoYmd) return '';
  const [y, m, d] = isoYmd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  }).format(dt);
};
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY,
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FB_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FB_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FB_SENDER_ID,
  appId: import.meta.env.VITE_FB_APP_ID,
  measurementId: import.meta.env.VITE_FB_MEASUREMENT_ID,
};
console.log("API KEY:", import.meta.env.VITE_FB_API_KEY);
console.log("FB ProjectID:", firebaseConfig.projectId);
const appFB = initializeApp(firebaseConfig);
const db = getFirestore(appFB);
const storage = getStorage(appFB);

const auth = getAuth(appFB);

// --- Email confirmations (EmailJS REST) ---
const EMAILJS_SERVICE = import.meta.env.VITE_EMAILJS_SERVICE_ID;
const EMAILJS_PUBLIC  = import.meta.env.VITE_EMAILJS_PUBLIC_KEY;
const EMAILJS_TPL_PARENT = import.meta.env.VITE_EMAILJS_TEMPLATE_PARENT;   // template para PADRES
const EMAILJS_TPL_TUTOR  = import.meta.env.VITE_EMAILJS_TEMPLATE_TUTOR;    // template para TUTORES
const EMAILJS_TPL_PAID   = import.meta.env.VITE_EMAILJS_TEMPLATE_PAID;     // template pago confirmado (se usará desde Admin)

// Helper para URL absoluta (para imágenes en emails)
// B) Versión robusta con dominio base y escape de URL
const PUBLIC_BASE = import.meta.env.VITE_PUBLIC_BASE_URL || (typeof window !== 'undefined' ? window.location.origin : '');
const absUrl = (u) => {
  if (!u) return '';
  const url = (u || '').trim();
  if (/^https?:\/\//i.test(url)) return encodeURI(url);
  if (url.startsWith('/')) return encodeURI(`${PUBLIC_BASE}${url}`);
  return encodeURI(`${PUBLIC_BASE}/${url}`);
};
// Placeholder por defecto para fotos de tutor en emails
const DEFAULT_TUTOR_PHOTO = '/tutores/default.jpg';

async function sendEmailJS(templateId, params) {
  if (!EMAILJS_SERVICE || !EMAILJS_PUBLIC || !templateId) {
    throw new Error('Faltan variables de EmailJS (service/public/template)');
  }
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE,
      template_id: templateId,
      user_id: EMAILJS_PUBLIC,
      template_params: params,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('EmailJS error: ' + t);
  }
}

async function sendReservationEmails({ parentEmail, tutorEmail, tutorName, tutorPhoto, parentName, student, modalidad, tipo, hours, whenText, total, bookingId, notes, manageUrl, logoUrl }) {
  const adminEmail = import.meta.env.VITE_ADMIN_EMAIL || '';
  const ccList = [adminEmail, tutorEmail].filter(Boolean).join(',');
  const manage = manageUrl || `${PUBLIC_BASE}/#/manage/${bookingId}`;

  await sendEmailJS(EMAILJS_TPL_PARENT, {
    to_email: parentEmail,
    cc: ccList,
    logoUrl: absUrl(logoUrl || '/logo-home.png'),
    parentName, student,
    tutorName,
    tutorPhoto: absUrl(tutorPhoto || DEFAULT_TUTOR_PHOTO),
    modalidad, tipo, hours,
    whenText, total, bookingId,
    notes: notes || '',
    manageUrl: manage
  });
}
// lead time (minutes) to hide near/future slots (e.g., 60 => hide slots that start within the next hour)
const LEAD_MINUTES = 60;

const parseHM = (hm) => {
  // 'HH:mm' -> minutes since midnight
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};
const toHM = (mins) => {
  const h = Math.floor(mins / 60).toString().padStart(2, '0');
  const m = (mins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
};
// Construye Date local evitando UTC
const combineDateAndTime = (dateISO, hm) => {
  const [y, m, d] = dateISO.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
};
const isSlotFutureWithLead = (s) => {
  const startDt = combineDateAndTime(s.dateISO, s.start);
  const now = new Date();
  const leadMs = LEAD_MINUTES * 60 * 1000;
  return startDt.getTime() - now.getTime() > leadMs; // must start after lead window
};
const overlaps = (aStart, aEnd, bStart, bEnd) => {
  // times in 'HH:mm'
  const a0 = parseHM(aStart), a1 = parseHM(aEnd);
  const b0 = parseHM(bStart), b1 = parseHM(bEnd);
  return Math.max(a0, b0) < Math.min(a1, b1);
};

// tutores por defecto (fotos en /public/tutores/*.jpg)
const DEFAULT_TUTORS = [];

// tarifas y paquetes
const PRICES = {
  horaPresencial: 65000,
  horaVirtual: 50000,
  // grupales (desde 3 estudiantes)
  grupalPresencialDesde: 50000,
  grupalVirtualDesde: 45000,
  paquetesPresenciales: { 4: 250000, 8: 505000, 10: 600000 },
  paquetesVirtuales:    { 4: 190000, 8: 385000, 10: 460000 },
};

// --- Tarifas especiales fin de semana / festivos (Colombia) ---
const WEEKEND_RATES = {
  presencial: 80000,
  virtual: 65000,
};
const NORMAL_RATES = {
  presencial: PRICES.horaPresencial,
  virtual: PRICES.horaVirtual,
};
// Festivos (observados en Colombia) — agrega/ajusta según calendario oficial
const CO_HOLIDAYS_YYYYMMDD = new Set([
  '2025-01-01','2025-01-06','2025-03-24','2025-04-17','2025-04-18','2025-05-01',
  '2025-05-19','2025-06-09','2025-06-23','2025-07-07','2025-07-20','2025-08-07',
  '2025-08-18','2025-10-13','2025-11-03','2025-11-17','2025-12-08','2025-12-25'
]);
const yyyymmdd = (iso) => {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
};
const isWeekendOrHoliday = (iso) => {
  const d = new Date(iso);
  const wk = d.getDay(); // 0=Domingo,6=Sábado
  if (wk === 0 || wk === 6) return true;
  return CO_HOLIDAYS_YYYYMMDD.has(yyyymmdd(iso));
};
const getRateForSlot = (modalidad, isoDate) => {
  return isWeekendOrHoliday(isoDate) ? WEEKEND_RATES[modalidad] : NORMAL_RATES[modalidad];
};
// Calcula total dinámico a partir de slots seleccionados (1h por slot)
const computeTotalFromSlots = (slotObjs, modalidad) => {
  if (!slotObjs || slotObjs.length === 0) return 0;
  return slotObjs.reduce((sum, s) => sum + getRateForSlot(modalidad, s.dateISO), 0);
};

// storage keys (v2 por cambios de estructura)
const LS = {
  TUTORS: 'lb_tutors_v2',
  SLOTS: 'lb_slots_v2',
  BOOKINGS: 'lb_bookings_v2',
  IS_TUTOR: 'lb_is_tutor',
};

// modalidades y opciones
const MODALIDADES = [
  { value: 'presencial', label: 'Presencial' },
  { value: 'virtual',    label: 'Virtual' },
];

// paquetes disponibles
const PACKAGE_OPTIONS = [
  { hours: 4,  label: 'Paquete 4 horas'  },
  { hours: 8,  label: 'Paquete 8 horas'  },
  { hours: 10, label: 'Paquete 10 horas' },
];


// calcula el total segun tipo de reserva
function computeTotal({ mode, modalidad, hours }) {
  if (mode === 'individual') {
    const amount = modalidad === 'presencial' ? PRICES.horaPresencial : PRICES.horaVirtual;
    return { amount, note: null };
  }
  if (mode === 'paquete') {
    if (modalidad === 'presencial' && PRICES.paquetesPresenciales[hours]) {
      return { amount: PRICES.paquetesPresenciales[hours], note: null };
    }
    if (modalidad === 'virtual' && PRICES.paquetesVirtuales[hours]) {
      return { amount: PRICES.paquetesVirtuales[hours], note: null };
    }
    return { amount: null, note: 'El valor del paquete se confirma por mensaje.' };
  }
  return { amount: null, note: null };
}

// Pequeño contenedor que hace fade-in al montarse
function Fade({ children, className = '', duration = 500 }) {
  const [visible, setVisible] = React.useState(false);
  React.useEffect(() => {
    // al montar, activa el fade
    const t = setTimeout(() => setVisible(true), 0);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className={`transition-opacity duration-500 ${visible ? 'opacity-100' : 'opacity-0'} ${className}`}>
      {children}
    </div>
  );
}

// ErrorBoundary simple para evitar pantalla en blanco
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, err: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, err: error };
  }
  componentDidCatch(error, info) {
    console.error(`[ErrorBoundary:${this.props.name||'App'}]`, error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 m-4 rounded-lg border bg-red-50 text-red-800">
          <div className="font-semibold">Algo salió mal en {this.props.name || 'la aplicación'}.</div>
          <div className="text-sm mt-1 break-all">{String(this.state.err)}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  // pestañas: home | prices | team | book | tutor | admin
  const [tab, setTab] = useState('home');
  // Gestión de reservas por enlace (#/manage/:id)
  const [manageId, setManageId] = useState('');
  const [manageBooking, setManageBooking] = useState(null);
  const [manageLoading, setManageLoading] = useState(false);
  const WHATSAPP_URL = import.meta.env.VITE_WHATSAPP_URL || '#';

  // tutor login
// tutor auth (Firebase)
const [isTutor, setIsTutor] = useState(false);
const [showLogin, setShowLogin] = useState(false);
const [loginEmail, setLoginEmail] = useState('');
const [loginPassword, setLoginPassword] = useState('');

  // datos
  const [tutors, setTutors] = useState([]);
  const [slots, setSlots] = useState([]);
  const [bookings, setBookings] = useState([]);

  // Tutor Portal forms
  const [newSlot, setNewSlot] = useState({ tutorId: '', date: '', start: '', end: '', modalidad: 'presencial' });
  const [newTutorName, setNewTutorName] = useState('');
  const [newTutorPhoto, setNewTutorPhoto] = useState('');
  const [newTutorEmail, setNewTutorEmail] = useState('');
  const [newTutorBio, setNewTutorBio] = useState('');

  // Admin: editar tutor
  const [editTutorId, setEditTutorId] = useState('');
  const [editTutorName, setEditTutorName] = useState('');
  const [editTutorPhoto, setEditTutorPhoto] = useState('');
  const [editTutorEmail, setEditTutorEmail] = useState('');
  const [editTutorBio, setEditTutorBio] = useState('');

  // Reservar – filtros rápidos
  const [filterTutorId, setFilterTutorId] = useState('');
  const [filterDate, setFilterDate] = useState('');
  const [filterModalidad, setFilterModalidad] = useState('');

  // Reservar – selector de modo
  const [bookingMode, setBookingMode] = useState('individual'); // 'individual' | 'paquete'

  // Individual
  const [singleSelectedSlot, setSingleSelectedSlot] = useState(null);

  // Paquete:
  const [selectedPackage, setSelectedPackage] = useState(4);
  const [selectedTutorForPkg, setSelectedTutorForPkg] = useState('');
  const [selectedModalidadForPkg, setSelectedModalidadForPkg] = useState('');
  const [selectedSlots, setSelectedSlots] = useState([]);

  // Confirmación (modal) + datos del padre
  const [showConfirm, setShowConfirm] = useState(false);
  // 1 = datos; 2 = pago/confirmación; 3 = éxito
  const [confirmStep, setConfirmStep] = useState(1);
  const [bookingForm, setBookingForm] = useState({
    parentName: '',
    email: '',
    student: '',
    subjects: '', // nuevas materias
    topics: '',   // temas específicos
    notes: '',
    paymentRef: ''
  });
  // Archivo de comprobante (opcional)
  const [paymentFile, setPaymentFile] = useState(null);
  // Estado de envío para evitar doble confirmación
  const [submitting, setSubmitting] = useState(false);
  // cargar / persistir
  useEffect(() => {
    const unsubTutors = onSnapshot(collection(db, 'tutors'), (snap) => {
      setTutors(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    const unsubSlots = onSnapshot(collection(db, 'slots'), (snap) => {
      const rows = snap.docs.map(d => {
        const raw = d.data();
        return {
          id: d.id,
          ...raw,
          dateISO: normYMD(raw.dateISO || raw.date || null), // fuerza 'YYYY-MM-DD'
          start: formatTime((raw.start || '').toString()),
          end: formatTime((raw.end || '').toString()),
          modalidad: (raw.modalidad || 'presencial')
        };
      });
      setSlots(rows);
    });

    const storedTutor = localStorage.getItem(LS.IS_TUTOR) === '1';
    setIsTutor(storedTutor);

    return () => {
      unsubTutors();
      unsubSlots();
    };
  }, []);

  useEffect(() => {
    if (!isTutor) {
      setBookings([]);
      return;
    }
    const unsub = onSnapshot(collection(db, 'bookings'), (snap) => {
      setBookings(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    return () => unsub();
  }, [isTutor]);

  // Cargar reserva para la página pública de gestión
  useEffect(() => {
    if (!manageId) {
      setManageBooking(null);
      return;
    }
    setManageLoading(true);
    getDoc(doc(db, 'bookings', manageId))
      .then(snap => setManageBooking(snap.exists() ? ({ id: snap.id, ...snap.data() }) : null))
      .catch(() => setManageBooking(null))
      .finally(() => setManageLoading(false));
  }, [manageId]);

  // Router simple basado en hash: #/manage/:id
  useEffect(() => {
    const applyHash = () => {
      const h = (location.hash || '').replace(/^#\/?/, '');
      const parts = h.split('/');
      if (parts[0] === 'manage' && parts[1]) {
        setManageId(parts[1]);
        setTab('manage');
      }
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setIsTutor(!!user);
      localStorage.setItem(LS.IS_TUTOR, user ? '1' : '0');
    });
    return () => unsub();
  }, []);
  useEffect(() => { localStorage.setItem(LS.IS_TUTOR, isTutor ? '1' : '0'); }, [isTutor]);

  // Precargar el formulario de edición cuando cambia el tutor seleccionado
  useEffect(() => {
    if (!editTutorId) {
  setEditTutorName('');
  setEditTutorPhoto('');
  setEditTutorEmail('');
  setEditTutorBio('');
  return;
}
const t = tutors.find(t => t.id === editTutorId);
if (t) {
  setEditTutorName(t.name || '');
  setEditTutorPhoto(t.photo || '');
  setEditTutorEmail(t.email || '');
  setEditTutorBio(t.bio || '');
}
  }, [editTutorId, tutors]);

  const tutorMap = useMemo(() => Object.fromEntries(tutors.map(t => [t.id, t])), [tutors]);

  // Tutor login (Firebase Auth)
const login = async () => {
  try {
    await signInWithEmailAndPassword(auth, loginEmail.trim(), loginPassword);
    setShowLogin(false);
    setLoginEmail('');
    setLoginPassword('');
    setTab('tutor');
  } catch (e) {
    alert('No se pudo iniciar sesión: ' + (e?.message || e));
  }
};

const logout = async () => {
  try {
    await signOut(auth);
    setTab('home');
  } catch (e) {
    alert('Error al cerrar sesión: ' + (e?.message || e));
  }
};

  // Tutor portal actions
    const addTutor = () => {
    const name = newTutorName.trim();
    if (!name) return alert('Escribe el nombre del tutor.');
    const email = newTutorEmail.trim();
    if (!email) return alert('Escribe el correo del tutor (para notificaciones).');
    const photo = newTutorPhoto.trim() || '/tutores/default.jpg';
    const bio = newTutorBio.trim() || 'Tutor/a de Lumina.';
    addDoc(collection(db, 'tutors'), { name, photo, email, bio })
      .then(() => {
        setNewTutorName(''); setNewTutorPhoto(''); setNewTutorEmail(''); setNewTutorBio('');
      })
      .catch((e) => alert('Error al agregar tutor: ' + e.message));
  };

  const addSlot = async () => {
    const { tutorId, date, start, end, modalidad } = newSlot;

    // Normaliza strings
    const _tutorId = (tutorId || '').trim();
    const _date = (date || '').trim();
    const _start = formatTime((start || '').trim());
    const _end = formatTime((end || '').trim());
    const _mod = (modalidad || '').trim();

    // Validaciones específicas y mensajes claros
    if (!_tutorId) return alert('Selecciona un tutor.');
    if (!_date) return alert('Selecciona una fecha.');
    if (!_start || !_end) return alert('Selecciona hora de inicio y fin.');
    if (!_mod) return alert('Selecciona la modalidad.');

    // Validar formato HH:mm
    const hmRe = /^\d{2}:\d{2}$/;
    if (!hmRe.test(_start) || !hmRe.test(_end)) {
      return alert('Formato de hora inválido. Usa HH:mm.');
    }

    const startM = parseHM(_start);
    const endM = parseHM(_end);
    if (Number.isNaN(startM) || Number.isNaN(endM)) return alert('Hora inválida.');
    if (endM <= startM) return alert('La hora de fin debe ser posterior a la de inicio.');

    const dateISO = toISODate(_date);

    const WINDOW = 60; // minutos por bloque
    const STEP = 30;   // desplazamiento

    if (endM - startM < WINDOW) return alert('El bloque debe ser de al menos 60 minutos.');

    try {
      // generar ventanas deslizantes de 1h cada 30min, todas dentro del bloque
      const ops = [];
      for (let t = startM; t + WINDOW <= endM; t += STEP) {
        const sHM = toHM(t);
        const eHM = toHM(t + WINDOW);
        const slot = { tutorId: _tutorId, dateISO, start: sHM, end: eHM, booked: false, blockedBy: null, modalidad: _mod };
        ops.push(addDoc(collection(db, 'slots'), slot));
      }
      await Promise.all(ops);
      setNewSlot({ tutorId: '', date: '', start: '', end: '', modalidad: 'presencial' });
      alert('Disponibilidad agregada como bloques de 1 hora cada 30 minutos.');
    } catch (e) {
      alert('Error al agregar disponibilidad: ' + e.message);
    }
  };

  const removeSlot = (id) => {
    deleteDoc(doc(db, 'slots', id)).catch((e) => alert('Error al eliminar: ' + e.message));
  };

  // listas filtradas
  const availableSlots = useMemo(() => {
    let s = slots.filter(s => !s.booked && !s.blockedBy && isSlotFutureWithLead(s));
    if (filterTutorId)     s = s.filter(x => x.tutorId === filterTutorId);
    if (filterDate)        s = s.filter(x => sameDay(x.dateISO, filterDate));
    if (filterModalidad)   s = s.filter(x => x.modalidad === filterModalidad);
    return s.sort((a,b) => (a.dateISO + a.start).localeCompare(b.dateISO + b.start));
  }, [slots, filterTutorId, filterDate, filterModalidad]);

  // elegibles para paquete (mismo tutor + misma modalidad)
  const pkgEligibleSlots = useMemo(() => {
    let s = slots.filter(s => !s.booked && !s.blockedBy && isSlotFutureWithLead(s));
    if (selectedTutorForPkg)     s = s.filter(x => x.tutorId === selectedTutorForPkg);
    if (selectedModalidadForPkg) s = s.filter(x => x.modalidad === selectedModalidadForPkg);
    return s.sort((a,b) => (a.dateISO + a.start).localeCompare(b.dateISO + b.start));
  }, [slots, selectedTutorForPkg, selectedModalidadForPkg]);

  // selección de slots del paquete
  const toggleSelectSlot = (slotId) => {
    setSelectedSlots(prev => {
      if (prev.includes(slotId)) return prev.filter(id => id !== slotId);
      if (prev.length >= selectedPackage) return prev;
      return [...prev, slotId];
    });
  };

  // abrir confirm para individual
  const openConfirmSingle = (slot) => {
    setSingleSelectedSlot(slot);
    setSelectedSlots([slot.id]);
    setSelectedTutorForPkg(slot.tutorId);
    setSelectedModalidadForPkg(slot.modalidad);
    setBookingMode('individual');
    setShowConfirm(true);
    setConfirmStep(1);
  };

  // abrir confirm para paquete
  const openConfirmPackage = () => {
    if (!selectedTutorForPkg || !selectedModalidadForPkg) return alert('Selecciona tutor y modalidad.');
    if (selectedSlots.length !== selectedPackage) return alert(`Debes elegir exactamente ${selectedPackage} horario(s).`);
    setSingleSelectedSlot(null);
    setBookingMode('paquete');
    setShowConfirm(true);
    setConfirmStep(1);
  };

  // confirmar reserva
  const confirmBooking = async () => {
    const { parentName, email, student, notes, paymentRef } = bookingForm;
    if (!parentName.trim() || !email.trim() || !student.trim()) return alert('Por favor completa nombre del padre/madre, correo y nombre del estudiante.');
    // Validación simple de email
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      alert('El correo parece inválido. Verifícalo por favor.');
      return;
    }
    // Evitar doble envío
    if (submitting) return;
    setSubmitting(true);
    // Validaciones de selección de slots / tutor / modalidad
    if (!selectedSlots || selectedSlots.length === 0) {
      alert('Debes seleccionar al menos un horario.');
      setSubmitting(false);
      return;
    }
    const tutorIdForBooking = selectedTutorForPkg || singleSelectedSlot?.tutorId || '';
    const modalidadForBooking = selectedModalidadForPkg || singleSelectedSlot?.modalidad || '';
    if (!tutorIdForBooking || !modalidadForBooking) {
      alert('Falta tutor o modalidad. Vuelve a seleccionar el horario.');
      setSubmitting(false);
      return;
    }

    // Verificar en servidor que los slots siguen libres y dentro de ventana permitida
    try {
      for (const id of selectedSlots) {
        const snap = await getDoc(doc(db, 'slots', id));
        if (!snap.exists()) {
          alert('Un horario seleccionado ya no existe.');
          setSubmitting(false);
          return;
        }
        const s = snap.data();
        if (s.booked || s.blockedBy) {
          alert('Un horario seleccionado acaba de ser reservado por otra persona. Actualiza la página y vuelve a intentar.');
          setSubmitting(false);
          return;
        }
        // Revalidar margen de anticipación (lead time)
        if (!isSlotFutureWithLead(s)) {
          alert('Un horario seleccionado quedó demasiado cerca de la hora actual y ya no se puede reservar.');
          setSubmitting(false);
          return;
        }
      }
    } catch (e) {
      alert('No se pudieron verificar los horarios seleccionados. Intenta de nuevo.');
      setSubmitting(false);
      return;
    }

    try {
      const batch = writeBatch(db);
      // crear booking id primero
      const bookingRef = doc(collection(db, 'bookings'));

        // Subir comprobante si se adjunta archivo (Storage)
        let paymentProofUrl = '';
        if (paymentFile) {
          paymentProofUrl = await (async () => {
            const safeName = (paymentFile.name || 'comprobante').replace(/[^\w.\-]/g, '_');
            const path = `paymentProofs/${bookingRef.id}/${safeName}`;
            const fileRef = sRef(storage, path);
            await uploadBytes(fileRef, paymentFile);
            return await getDownloadURL(fileRef);
          })();
        }

      // marcar seleccionados como reservados
      selectedSlots.forEach(id => {
        batch.update(doc(db, 'slots', id), { booked: true, blockedBy: bookingRef.id });
      });

      // bloquear slots solapados (mismo tutor, misma fecha, misma modalidad)
      const selectedObjs = slots.filter(s => selectedSlots.includes(s.id));
      slots.forEach(s => {
        if (s.booked || s.blockedBy) return;
        const sameTutor = selectedObjs.some(x => x.tutorId === s.tutorId && x.dateISO === s.dateISO && x.modalidad === s.modalidad && overlaps(x.start, x.end, s.start, s.end));
        if (sameTutor) {
          batch.update(doc(db, 'slots', s.id), { blockedBy: bookingRef.id });
        }
      });

      // crear reserva
      batch.set(bookingRef, {
        slotIds: selectedSlots.slice(),
        tutorId: tutorIdForBooking,
        modalidad: modalidadForBooking,
        hours: bookingMode === 'individual' ? 1 : selectedPackage,
        mode: bookingMode,
        parentName: parentName.trim(),
        email: email.trim(),
        student: student.trim(),
        notes: (notes || '').trim(),
        paymentStatus: 'pendiente',
        paymentRef: (paymentRef || '').trim(),
        paymentProofUrl,
        subjects: (bookingForm.subjects || '').trim(),
        topics: (bookingForm.topics || '').trim(),  
        createdAtISO: new Date().toISOString(),
      });
      try {
        await batch.commit();
      } catch (e) {
        alert('Error al confirmar: ' + e.message);
        setSubmitting(false);
        return;
      }
      
      // enviar correos por EmailJS (sin abrir cliente)
      try {
        const t = tutorMap[tutorIdForBooking];
        const slotList = selectedSlots.map(id => slots.find(s => s.id === id)).filter(Boolean);
        const whenText = slotList.map(s => `${new Date(s.dateISO).toLocaleDateString('es-ES')} ${s.start}–${s.end}`).join(', ');
        const tipo = bookingMode === 'individual' ? 'Clase individual' : `Paquete ${selectedPackage} horas`;
        const hours = bookingMode === 'individual' ? 1 : selectedPackage;
        const amount = computeTotalFromSlots(slotList, modalidadForBooking);
        const total = amount ? `$${fmtCOP(amount)} COP` : '—';
      
        await sendReservationEmails({
          parentEmail: email.trim(),
          tutorEmail: t?.email || '',
          tutorName: t?.name || 'Tutor',
          tutorPhoto: t?.photo || '',
          parentName: parentName.trim(),
          student: student.trim(),
          modalidad: modalidadForBooking,
          tipo,
          hours,
          whenText,
          total,
          bookingId: bookingRef.id,
          notes: (notes || '').trim(),
          manageUrl: `${PUBLIC_BASE}/#/manage/${bookingRef.id}`,
          manageUrlTutor: '#',
          logoUrl: '/logo-home.png'
        });
      } catch (e) {
        console.warn('Error al enviar emails via EmailJS:', e);
      }
      
      setSelectedSlots([]);
      setSingleSelectedSlot(null);
      setBookingForm({ parentName: '', email: '', student: '', subjects: '', topics: '', notes: '', paymentRef: '' });
      setPaymentFile(null);
      setConfirmStep(3); // mostrar pantalla de éxito en el modal
      setSubmitting(false);
    } catch (e) {
      alert('Error al confirmar: ' + e.message);
      setSubmitting(false);
      return;
    }
  };

  // cancelar desde admin
  const cancelBooking = (bookingId) => {
    const booking = bookings.find(b => b.id === bookingId);
    if (!booking) return;
    const batch = writeBatch(db);
    // liberar slots reservados
    booking.slotIds.forEach(id => {
      batch.update(doc(db, 'slots', id), { booked: false, blockedBy: null });
    });
    // liberar slots bloqueados por este booking
    slots.forEach(s => {
      if (s.blockedBy === bookingId) {
        batch.update(doc(db, 'slots', s.id), { blockedBy: null });
      }
    });
    batch.delete(doc(db, 'bookings', bookingId));
    batch.commit().catch((e) => alert('Error al cancelar: ' + e.message));
  };

  // total a mostrar en el modal
  const totalInfo = (() => {
    const modalidad = selectedModalidadForPkg || singleSelectedSlot?.modalidad || 'presencial';
    const chosenSlots = selectedSlots.map(id => slots.find(s => s.id === id)).filter(Boolean);
    const amount = computeTotalFromSlots(chosenSlots, modalidad);
    return { amount, note: null };
  })();

  // ---------- UI ----------
  return (
    <div className="min-h-screen bg-gradient-to-b from-white via-indigo-50 to-indigo-100 text-gray-900 transition-colors duration-500">
      {/* Barra superior */}
      <header className="sticky top-0 z-20 backdrop-blur bg-white/70 border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <nav className="flex gap-2 justify-center w-full">
            <button onClick={() => setTab('home')}   className={'px-3 py-1.5 rounded-lg border transition duration-200 ' + (tab==='home'   ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white hover:bg-gray-50')}>Inicio</button>
            <button onClick={() => setTab('prices')} className={'px-3 py-1.5 rounded-lg border transition duration-200 ' + (tab==='prices' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white hover:bg-gray-50')}>Precios</button>
            <button onClick={() => setTab('team')}   className={'px-3 py-1.5 rounded-lg border transition duration-200 ' + (tab==='team'   ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white hover:bg-gray-50')}>Tutores</button>
            <button onClick={() => setTab('book')}   className={'px-3 py-1.5 rounded-lg border transition duration-200 ' + (tab==='book'   ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white hover:bg-gray-50')}>Reservar</button>

            {isTutor && (
              <>
                <button onClick={() => setTab('tutor')} className={'px-3 py-1.5 rounded-lg border transition duration-200 ' + (tab==='tutor' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white hover:bg-gray-50')}>Portal tutores</button>
                <button onClick={() => setTab('admin')} className={'px-3 py-1.5 rounded-lg border transition duration-200 ' + (tab==='admin' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white hover:bg-gray-50')}>Administración</button>
              </>
            )}

            {!isTutor ? (
              <button onClick={() => setShowLogin(true)} className="px-3 py-1.5 rounded-lg border bg-white hover:bg-gray-50 transition duration-200" title="Solo tutores">Ingreso tutor</button>
            ) : (
              <button onClick={logout} className="px-3 py-1.5 rounded-lg border bg-white hover:bg-gray-50 transition duration-200">Salir</button>
            )}
          </nav>
        </div>
      </header>

      {/* Páginas */}
      <main className="max-w-6xl mx-auto px-4 py-8 space-y-10">

        {/* HOME (centrado vertical + logo transparente arriba) */}
        {tab === 'home' && (
          <Fade>
            <section className="min-h-[70vh] flex flex-col items-center justify-center text-center">
              {/* Logo de portada (transparente): coloca /public/logo-home.png */}
              <img src="/logo-home.png" alt="Lumina" className="w-80 h-80 mb-1 object-contain" />

              <div>
                <h2 className="text-4xl sm:text-6xl font-semibold tracking-tight leading-tight">
                  Lumina
                  <div className="text-2xl sm:text-3xl font-medium mt-1">Tutorías personalizadas</div>
                </h2>
                <p className="mt-4 text-gray-600 text-lg italic">
                  Te llevamos a la excelencia académica con una sonrisa
                </p>
              </div>

              <div className="mt-8 grid sm:grid-cols-3 gap-4 w-full max-w-3xl">
                <button onClick={() => setTab('prices')} className="rounded-2xl border bg-white p-6 transition hover:shadow-lg hover:scale-[1.01] duration-300">
                  <h3 className="text-lg font-semibold">Ver precios</h3>
                  <p className="text-sm text-gray-600 mt-1">Tarifas por hora y paquetes.</p>
                </button>
                <button onClick={() => setTab('team')} className="rounded-2xl border bg-white p-6 transition hover:shadow-lg hover:scale-[1.01] duration-300">
                  <h3 className="text-lg font-semibold">Nuestros tutores</h3>
                  <p className="text-sm text-gray-600 mt-1">Profesionales listos para ayudarte.</p>
                </button>
                <button onClick={() => setTab('book')} className="rounded-2xl border bg-white p-6 transition hover:shadow-lg hover:scale-[1.01] duration-300">
                  <h3 className="text-lg font-semibold">Reservar</h3>
                  <p className="text-sm text-gray-600 mt-1">Elige fecha, modalidad y cupo.</p>
                </button>
              </div>
            </section>
          </Fade>
        )}

        {/* PRECIOS (dos recuadros + 3 botones abajo) */}
        {tab === 'prices' && (
          <Fade>
            <section className="space-y-8">
              <h1 className="text-xl font-semibold">Tarifas y paquetes</h1>

              <div className="grid md:grid-cols-2 gap-6">
                {/* Presencial */}
                <div className="rounded-2xl border bg-white p-6">
                  <h3 className="text-lg font-semibold">Presencial</h3>
                  <p className="text-sm text-gray-700 mt-1">¿Te interesan las clases didácticas y cercanas? ¡Te recomendamos una clase presencial!</p>
                  <ul className="mt-4 space-y-1 text-sm text-gray-800">
                    <li><b>Precio por hora:</b> ${fmtCOP(PRICES.horaPresencial)} COP</li>
                    <li><b>Clases grupales: </b>desde ${fmtCOP(PRICES.grupalPresencialDesde)} COP desde 3 estudiantes</li>
                    <li><b>Paquete 4 horas:</b>${fmtCOP(PRICES.paquetesPresenciales[4])} COP</li>
                    <li><b>Paquete 8 horas: </b>${fmtCOP(PRICES.paquetesPresenciales[8])} COP</li>
                    <li><b>Paquete 10 horas: </b>${fmtCOP(PRICES.paquetesPresenciales[10])} COP</li>
                    <li className="text-xs text-gray-500 mt-2">Sábados, domingos y festivos: ${fmtCOP(WEEKEND_RATES.presencial)} COP por hora.</li>
                  </ul>
                </div>

                {/* Virtual */}
                <div className="rounded-2xl border bg-white p-6">
                  <h3 className="text-lg font-semibold">Virtual</h3>
                  <p className="text-sm text-gray-700 mt-1">¿Te interesa la flexibilidad y la tecnología? ¡Te recomendamos una clase virtual!</p>
                  <ul className="mt-4 space-y-1 text-sm text-gray-800">
                    <li><b>Precio por hora: </b>${fmtCOP(PRICES.horaVirtual)} COP</li>
                    <li><b>Clases grupales: </b>desde ${fmtCOP(PRICES.grupalVirtualDesde)} COP desde 3 estudiantes</li>
                    <li><b>Paquete 4 horas: </b>${fmtCOP(PRICES.paquetesVirtuales[4])} COP</li>
                    <li><b>Paquete 8 horas: </b>${fmtCOP(PRICES.paquetesVirtuales[8])} COP</li>
                    <li><b>Paquete 10 horas: </b>${fmtCOP(PRICES.paquetesVirtuales[10])} COP</li>
                    <li className="text-xs text-gray-500 mt-2">Sábados, domingos y festivos: ${fmtCOP(WEEKEND_RATES.virtual)} COP por hora.</li>
                  </ul>
                </div>
              </div>

              <div className="rounded-2xl border bg-white p-6">
                <h3 className="text-lg font-semibold">Tarifas fin de semana y festivos</h3>
                <p className="text-sm text-gray-700 mt-1">
                  Las clases programadas en <b>sábado, domingo o festivos (Colombia)</b> tienen tarifa especial:
                </p>
                <ul className="mt-3 space-y-1 text-sm text-gray-800">
                  <li><b>Presencial:</b> ${fmtCOP(WEEKEND_RATES.presencial)} COP por hora</li>
                  <li><b>Virtual:</b> ${fmtCOP(WEEKEND_RATES.virtual)} COP por hora</li>
                </ul>
                <p className="text-xs text-gray-500 mt-2">La tarifa se calcula automáticamente según la fecha de cada clase.</p>
              </div>

              {/* Botones inferiores */}
              <div className="grid sm:grid-cols-3 gap-4">
                {/* Reemplaza href con tu enlace real (WhatsApp, formulario, etc.) */}
                <a href="#" target="_blank" rel="noopener" className="text-left rounded-2xl border bg-white p-6 transition hover:shadow-lg hover:scale-[1.01] duration-300">
                  <h3 className="text-lg font-semibold">¿Necesitas otras opciones?</h3>
                  <p className="text-sm text-gray-600 mt-1">Contáctanos para más opciones</p>
                </a>
                <button onClick={() => setTab('team')} className="text-left rounded-2xl border bg-white p-6 transition hover:shadow-lg hover:scale-[1.01] duration-300">
                  <h3 className="text-lg font-semibold">¿Quieres saber más?</h3>
                  <p className="text-sm text-gray-600 mt-1">Conoce a nuestros tutores</p>
                </button>
                <button onClick={() => setTab('book')} className="text-left rounded-2xl border bg-white p-6 transition hover:shadow-lg hover:scale-[1.01] duration-300">
                  <h3 className="text-lg font-semibold">¿Estás listo?</h3>
                  <p className="text-sm text-gray-600 mt-1">¡Reserva ya!</p>
                </button>
              </div>
            </section>
          </Fade>
        )}

        {/* TUTORES */}
        {tab === 'team' && (
          <Fade>
            <section className="space-y-6">
              <h2 className="text-xl font-semibold">Conoce a nuestros tutores</h2>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {tutors.map(t => (
                  <article key={t.id} className="border rounded-2xl bg-white p-5 shadow-sm transition hover:shadow-lg hover:scale-[1.01] duration-300">
                    <img src={t.photo || '/tutores/default.jpg'} alt={t.name} className="w-full h-64 object-cover rounded-xl" />
                    <div className="mt-4 text-center">
                      <h3 className="text-xl font-semibold">{t.name}</h3>
                      <p className="text-base text-gray-700">{t.bio || 'Tutor/a de Lumina.'}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </Fade>
        )}

        {/* RESERVAR */}
        {tab === 'book' && (
          <Fade>
          <section className="space-y-8">
            {/* Elegir tipo de reserva */}
            <div className="rounded-2xl border bg-white p-4">
              <h3 className="font-semibold mb-3">Tipo de reserva</h3>
              <div className="flex gap-2">
                <button
                  className={'px-3 py-2 rounded-lg border ' + (bookingMode==='individual' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white')}
                  onClick={() => { setBookingMode('individual'); setSelectedSlots([]); setSingleSelectedSlot(null); }}
                >
                  Clase individual
                </button>
                <button
                  className={'px-3 py-2 rounded-lg border ' + (bookingMode==='paquete' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white')}
                  onClick={() => { setBookingMode('paquete'); setSingleSelectedSlot(null); setSelectedSlots([]); }}
                >
                  Paquete
                </button>
              </div>
            </div>

            {/* Filtros generales */}
            <div className="rounded-2xl border bg-white p-4 space-y-3">
              <h3 className="font-semibold">Filtros rápidos</h3>
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <select className="border rounded-lg px-3 py-2 bg-white" value={filterTutorId} onChange={e => setFilterTutorId(e.target.value)}>
                  <option value="">Todos los tutores</option>
                  {tutors.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <input type="date" className="border rounded-lg px-3 py-2 bg-white" value={filterDate} onChange={e => setFilterDate(e.target.value)} />
                <select className="border rounded-lg px-3 py-2 bg-white" value={filterModalidad} onChange={e => setFilterModalidad(e.target.value)}>
                  <option value="">Cualquier modalidad</option>
                  {MODALIDADES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
                <button className="px-3 py-2 rounded-lg border bg-white hover:shadow" onClick={() => { setFilterTutorId(''); setFilterDate(''); setFilterModalidad(''); }}>
                  Limpiar filtros
                </button>
              </div>
            </div>

            {/* BLOQUE: CLASE INDIVIDUAL */}
            {bookingMode === 'individual' && (
              <div className="space-y-3">
                <h3 className="font-semibold">Elige un horario (clase individual)</h3>
                {availableSlots.length === 0 ? (
                  <div className="text-gray-600">No hay horarios disponibles con esos filtros.</div>
                ) : (
                  <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
                    {availableSlots.map(s => (
                      <li key={s.id} className="border rounded-2xl bg-white p-5 shadow-sm transition hover:shadow-lg hover:scale-[1.01] duration-300 space-y-2">
                        <div className="text-sm text-gray-500">{fmtDateLongEs(s.dateISO)}</div>
                        <div className="text-lg font-medium">{tutorMap[s.tutorId]?.name || 'Tutor'}</div>
                        <div className="text-gray-700">{s.start} – {s.end}</div>
                        <div className="text-xs text-gray-600">Modalidad: {s.modalidad}</div>
                        <button onClick={() => openConfirmSingle(s)} className="mt-2 w-full py-2 rounded-lg bg-indigo-600 text-white transition duration-300 hover:opacity-95 active:scale-[0.99]">
                          Reservar esta hora
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* BLOQUE: PAQUETE */}
            {bookingMode === 'paquete' && (
              <div className="rounded-2xl border bg-white p-4 space-y-4">
                <h3 className="font-semibold">Reserva por paquete</h3>
                <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <select className="border rounded-lg px-3 py-2 bg-white" value={selectedPackage} onChange={e => { setSelectedPackage(Number(e.target.value)); setSelectedSlots([]); }}>
                    {PACKAGE_OPTIONS.map(p => <option key={p.hours} value={p.hours}>{p.label}</option>)}
                  </select>
                  <select className="border rounded-lg px-3 py-2 bg-white" value={selectedTutorForPkg} onChange={e => { setSelectedTutorForPkg(e.target.value); setSelectedSlots([]); }}>
                    <option value="">Seleccionar tutor</option>
                    {tutors.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <select className="border rounded-lg px-3 py-2 bg-white" value={selectedModalidadForPkg} onChange={e => { setSelectedModalidadForPkg(e.target.value); setSelectedSlots([]); }}>
                    <option value="">Seleccionar modalidad</option>
                    {MODALIDADES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>

                {/* Lista para seleccionar N horarios */}
                <div>
                  <p className="text-sm text-gray-600">Selecciona <b>{selectedPackage}</b> horario(s) disponibles de la combinación seleccionada.</p>
                  <ul className="mt-3 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {pkgEligibleSlots.length === 0 && <li className="text-gray-500">Sin horarios disponibles con esa combinación.</li>}
                    {pkgEligibleSlots.map(s => {
                      const chosen = selectedSlots.includes(s.id);
                      return (
                        <li
                          key={s.id}
                          onClick={() => toggleSelectSlot(s.id)}
                          className={
                            'cursor-pointer border rounded-2xl bg-white p-4 shadow-sm transition duration-300 space-y-1 ' +
                            (chosen
                              ? 'ring-2 ring-indigo-400 scale-[1.01]'
                              : 'hover:shadow-lg hover:scale-[1.01]')
                          }
                        >
                          <div className="text-sm text-gray-500">{fmtDateLongEs(s.dateISO)}</div>
                          <div className="text-gray-800">{s.start} – {s.end}</div>
                          <div className="text-xs text-gray-600">Modalidad: {s.modalidad}</div>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="text-sm text-gray-600 mt-2">Seleccionados: <b>{selectedSlots.length}</b> / {selectedPackage}</div>
                </div>

                {/* Acciones + total estimado (pre-confirmación) */}
                <div className="flex items-center justify-between">
                  <div className="text-sm">
                    {(() => {
                      const { amount, note } = computeTotal({
                        mode: 'paquete',
                        modalidad: selectedModalidadForPkg || 'presencial',
                        hours: selectedPackage
                      });
                      return (
                        <>
                          <div><b>Total estimado:</b> {amount ? `$${fmtCOP(amount)}` : '—'}</div>
                          {note && <div className="text-gray-500">{note}</div>}
                        </>
                      );
                    })()}
                  </div>

                  <button
                    className="px-3 py-2 rounded-lg bg-indigo-600 text-white disabled:opacity-50 transition duration-300 hover:opacity-95 active:scale-[0.99]"
                    disabled={selectedSlots.length !== selectedPackage || !selectedTutorForPkg || !selectedModalidadForPkg}
                    onClick={openConfirmPackage}
                  >
                    Continuar
                  </button>
                </div>
              </div>
            )}
          </section>
          </Fade>
        )}

        {/* PORTAL TUTORES */}
        {tab === 'tutor' && isTutor && (
          <ErrorBoundary name="Portal tutores">
            <Fade>
            <section className="space-y-8">
            <h2 className="text-xl font-semibold">Portal de tutores</h2>

            {/* Agregar tutor */}
            <div className="rounded-2xl border bg-white p-4 space-y-2">
              <h3 className="font-medium">Agregar tutor</h3>
              <div className="grid sm:grid-cols-4 gap-2">
                <input className="border rounded-lg px-3 py-2" placeholder="Nombre del tutor" value={newTutorName} onChange={e => setNewTutorName(e.target.value)} />
                <input className="border rounded-lg px-3 py-2" placeholder="Foto (URL o /tutores/ana.jpg)" value={newTutorPhoto} onChange={e => setNewTutorPhoto(e.target.value)} />
                <input className="border rounded-lg px-3 py-2" placeholder="Correo del tutor" value={newTutorEmail} onChange={e => setNewTutorEmail(e.target.value)} />
                <input className="border rounded-lg px-3 py-2" placeholder="Breve descripción" value={newTutorBio} onChange={e => setNewTutorBio(e.target.value)} />
              </div>
              <div className="flex justify-end">
                <button className="px-3 py-2 rounded-lg bg-indigo-600 text-white transition duration-300 hover:opacity-95 active:scale-[0.99]" onClick={addTutor}>
                  Agregar
                </button>
              </div>
            </div>

            {/* Agregar disponibilidad */}
            <div className="rounded-2xl border bg-white p-4 space-y-3">
              <h3 className="font-medium">Agregar disponibilidad</h3>
              <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
                <select className="border rounded-lg px-3 py-2 bg-white" value={newSlot.tutorId} onChange={e => setNewSlot(s => ({ ...s, tutorId: e.target.value }))}>
                  <option value="">Seleccionar tutor</option>
                  {tutors.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <input type="date" className="border rounded-lg px-3 py-2 bg-white" value={newSlot.date} onChange={e => setNewSlot(s => ({ ...s, date: e.target.value }))} />
                <input type="time" className="border rounded-lg px-3 py-2 bg-white" value={newSlot.start} onChange={e => setNewSlot(s => ({ ...s, start: e.target.value }))} />
                <input type="time" className="border rounded-lg px-3 py-2 bg-white" value={newSlot.end} onChange={e => setNewSlot(s => ({ ...s, end: e.target.value }))} />
                <select className="border rounded-lg px-3 py-2 bg-white" value={newSlot.modalidad} onChange={e => setNewSlot(s => ({ ...s, modalidad: e.target.value }))}>
                  {MODALIDADES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <button className="px-3 py-2 rounded-lg bg-indigo-600 text-white transition duration-300 hover:opacity-95 active:scale-[0.99]" onClick={addSlot}>Agregar disponibilidad</button>

              <div className="pt-4 space-y-2">
                <h4 className="font-medium">Todos los horarios</h4>
                <ul className="space-y-2">
                  {slots.length === 0 && <li className="text-gray-600">Sin horarios todavía.</li>}
                  {(slots || []).map((s) => {
                    if (!s || !s.id) return null;
                    const tutorName = tutorMap[s.tutorId]?.name || 'Tutor';
                    const dateText = fmtDateLongEs(s.dateISO || '');
                    const start = s.start || '--:--';
                    const end = s.end || '--:--';
                    return (
                      <li key={s.id} className="flex items-center justify-between border rounded-lg bg-white px-3 py-2">
                        <div className="text-sm">
                          <span className="text-gray-500">{dateText}</span>
                          {' • '}<span>{start}–{end}</span>
                          {' • '}<span className="font-medium">{tutorName}</span>
                          {' • '}<span className="text-gray-600 capitalize">{s.modalidad || '—'}</span>
                          {s.booked && <span className="ml-2 text-green-700 font-medium">(reservado)</span>}
                        </div>
                        <button className="text-red-700 hover:underline transition duration-300" onClick={() => removeSlot(s.id)}>eliminar</button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
            </section>
            </Fade>
          </ErrorBoundary>
        )}

        {/* ADMIN */}
        {tab === 'admin' && isTutor && (
          <Fade>
          <section className="space-y-6">
            <h2 className="text-xl font-semibold">Administración</h2>
            <div className="flex justify-end">
              <button
                className="px-3 py-2 rounded-lg border bg-white transition duration-300 hover:shadow hover:opacity-95 active:scale-[0.99] text-red-700"
                onClick={() => {
                  if (confirm('¿Seguro que quieres borrar todos los datos (tutores, horarios y reservas)?')) {
                    (async () => {
                      try {
                        const batch = writeBatch(db);
                        const colls = ['bookings', 'slots', 'tutors'];
                        for (const cName of colls) {
                          const snap = await getDocs(collection(db, cName));
                          snap.forEach(d => batch.delete(doc(db, cName, d.id)));
                        }
                        await batch.commit();
                        alert('Datos borrados en la nube. Ahora puedes crear tutores desde el portal.');
                      } catch (e) {
                        alert('Error al borrar datos: ' + e.message);
                      }
                    })();
                  }
                }}
              >
                Resetear datos (borrar todo)
              </button>
            </div>
            <div className="rounded-2xl border bg-white p-4 space-y-3">
              <h3 className="font-medium">Editar tutor</h3>
              <div className="grid sm:grid-cols-5 gap-2">
                <select
                  className="border rounded-lg px-3 py-2 bg-white"
                  value={editTutorId}
                  onChange={e => setEditTutorId(e.target.value)}
                >
                  <option value="">Seleccionar tutor</option>
                  {tutors.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <input
                  className="border rounded-lg px-3 py-2"
                  placeholder="Nombre"
                  value={editTutorName}
                  onChange={e => setEditTutorName(e.target.value)}
                  disabled={!editTutorId}
                />
                <input
                  className="border rounded-lg px-3 py-2"
                  placeholder="Foto (URL o /tutores/ana.jpg)"
                  value={editTutorPhoto}
                  onChange={e => setEditTutorPhoto(e.target.value)}
                  disabled={!editTutorId}
                />
                <input
                  className="border rounded-lg px-3 py-2"
                  placeholder="Correo del tutor"
                  value={editTutorEmail}
                  onChange={e => setEditTutorEmail(e.target.value)}
                  disabled={!editTutorId}
                />
                <input
                  className="border rounded-lg px-3 py-2"
                  placeholder="Descripción"
                  value={editTutorBio}
                  onChange={e => setEditTutorBio(e.target.value)}
                  disabled={!editTutorId}
                />
              </div>
              <div className="flex justify-end">
                <button
                  className="px-3 py-2 rounded-lg bg-indigo-600 text-white transition duration-300 hover:opacity-95 active:scale-[0.99]"
                  onClick={() => {
                    if (!editTutorId) return alert('Selecciona un tutor.');
                    const name = editTutorName.trim();
                    if (!name) return alert('El nombre no puede estar vacío.');
                    const email = editTutorEmail.trim();
                    if (!email) return alert('El correo del tutor no puede estar vacío.');
                    const photo = editTutorPhoto.trim() || '/tutores/default.jpg';
                    const bio = editTutorBio.trim() || 'Tutor/a de Lumina.';
                    updateDoc(doc(db, 'tutors', editTutorId), { name, photo, email, bio })
                      .then(() => alert('Información del tutor actualizada.'))
                      .catch((e) => alert('Error al actualizar tutor: ' + e.message));
                  }}
                  disabled={!editTutorId}
                >
                  Guardar cambios
                </button>
              </div>
            </div>
            <div className="border rounded-2xl bg-white shadow-sm overflow-hidden">
              <table className="w-full text-left">
                <thead className="text-sm text-gray-600 border-b bg-gray-50">
                  <tr>
                    <th className="px-4 py-2">Modo</th>
                    <th className="px-4 py-2">Tutor</th>
                    <th className="px-4 py-2">Modalidad</th>
                    <th className="px-4 py-2">Horas</th>
                    <th className="px-4 py-2">Horarios</th>
                    <th className="px-4 py-2">Estudiante</th>
                    <th className="px-4 py-2">Padre/Madre</th>
                    <th className="px-4 py-2">Correo</th>
                    <th className="px-4 py-2">Pago</th>
                    <th className="px-4 py-2">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.length === 0 && (
                    <tr><td colSpan="10" className="px-4 py-3 text-gray-600">Aún no hay reservas.</td></tr>
                  )}
                  {bookings.map(b => {
                    const tut = tutorMap[b.tutorId];
                    const slotList = b.slotIds.map(id => slots.find(s => s.id === id)).filter(Boolean);
                    const when = slotList.map(s => `${fmtDateLongEs(normYMD(s.dateISO))} ${s.start ?? '--:--'}–${s.end ?? '--:--'}`).join(' | ');
                    return (
                      <tr key={b.id} className="border-b align-top">
                        <td className="px-4 py-2 text-sm capitalize">{b.mode || '—'}</td>
                        <td className="px-4 py-2 text-sm">{tut?.name}</td>
                        <td className="px-4 py-2 text-sm capitalize">{b.modalidad}</td>
                        <td className="px-4 py-2 text-sm">{b.hours}</td>
                        <td className="px-4 py-2 text-sm">{when}</td>
                        <td className="px-4 py-2 text-sm">{b.student}</td>
                        <td className="px-4 py-2 text-sm">{b.parentName}</td>
                        <td className="px-4 py-2 text-sm">{b.email}</td>
                        <td className="px-4 py-2 text-sm">
                      {b.paymentStatus === 'confirmado' ? (
                        <span className="text-green-700 font-medium">Confirmado</span>
                      ) : (
                        <span className="text-orange-700">Pendiente</span>
                      )}
                      {b.paymentProofUrl ? (
                        <div>
                          <a href={b.paymentProofUrl} target="_blank" rel="noopener" className="text-indigo-600 hover:underline">Ver comprobante</a>
                        </div>
                      ) : (
                        <div className="text-gray-500">Sin comprobante</div>
                      )}
                      {b.paymentStatus !== 'confirmado' && (
                        <button
                          className="mt-1 text-sm text-green-700 hover:underline"
                          onClick={async () => {
                            try {
                              await updateDoc(doc(db, 'bookings', b.id), { paymentStatus: 'confirmado' });
                              // Enviar correo de pago confirmado
                              const parentEmail = b.email;
                              const tut = tutorMap[b.tutorId];
                              const slotList = b.slotIds.map(id => slots.find(s => s.id === id)).filter(Boolean);
                              const whenText = slotList.map(s => `${fmtDateLongEs(s.dateISO)} ${s.start}–${s.end}`).join(', ');
                              const tipo = b.mode === 'individual' ? 'Clase individual' : `Paquete ${b.hours} horas`;
                              const modalidad = b.modalidad;
                              const amount = computeTotalFromSlots(slotList, modalidad);
                              const total = amount ? `$${fmtCOP(amount)} COP` : '—';
                              const adminEmail = import.meta.env.VITE_ADMIN_EMAIL || '';

                              await sendEmailJS(EMAILJS_TPL_PAID, {
                                to_email: parentEmail,
                                cc: [tut?.email, adminEmail].filter(Boolean).join(','),
                                parentName: b.parentName,
                                student: b.student,
                                tutorName: tut?.name || 'Tutor',
                                modalidad,
                                tipo,
                                hours: b.hours,
                                whenText,
                                total,
                                bookingId: b.id,
                                manageUrl: '#'
                              });

                              alert('Pago confirmado y correo enviado.');
                            } catch (e) {
                              alert('Error al confirmar pago: ' + (e?.message || e));
                            }
                          }}
                        >
                          Confirmar pago
                        </button>
                      )}
                    </td>
                        <td className="px-4 py-2">
                          <button className="text-red-700 hover:underline text-sm transition duration-300" onClick={() => cancelBooking(b.id)}>cancelar</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
          </Fade>
        )}
        {/* MANAGE: página pública para gestionar reserva por enlace */}
        {tab === 'manage' && (
          <Fade>
            <section className="space-y-6">
              <h2 className="text-xl font-semibold">Gestionar mi reserva</h2>
              {manageLoading && <div className="text-gray-600">Cargando reserva…</div>}
              {!manageLoading && !manageBooking && (
                <div className="rounded-2xl border bg-white p-4">No encontramos esta reserva. Verifica el enlace.</div>
              )}
              {!manageLoading && manageBooking && (() => {
                const b = manageBooking;
                const slotList = b.slotIds.map(id => slots.find(s => s.id === id)).filter(Boolean);
                const when = slotList.map(s => `${fmtDateLongEs(normYMD(s.dateISO))} ${s.start ?? '--:--'}–${s.end ?? '--:--'}`).join(' | ');
                // Diferencia horaria hasta el primer slot (regla de 24 h)
                const firstStart = slotList
                  .map(s => combineDateAndTime(s.dateISO, s.start))
                  .sort((a,c) => a.getTime() - c.getTime())[0];
                const hoursLeft = firstStart ? (firstStart.getTime() - Date.now()) / 36e5 : 0;
                const canChange = hoursLeft >= 24;
                return (
                  <div className="rounded-2xl border bg-white p-4 space-y-3">
                    <div><b>Reserva:</b> {b.id}</div>
                    <div><b>Estudiante:</b> {b.student}</div>
                    <div><b>Tutor:</b> {tutorMap[b.tutorId]?.name || 'Tutor'}</div>
                    <div><b>Modalidad:</b> {b.modalidad}</div>
                    <div><b>Tipo:</b> {b.mode === 'individual' ? 'Clase individual' : `Paquete ${b.hours} horas`}</div>
                    <div><b>Horario(s):</b> {when}</div>
                    <div><b>Estado de pago:</b> {b.paymentStatus || 'pendiente'}</div>
                    <div className="p-3 rounded-lg bg-indigo-50 text-sm">
                      {canChange ? (
                        <>
                          <div className="font-medium">Puedes solicitar un cambio de horario.</div>
                          <p>Por ahora los cambios se gestionan por WhatsApp para coordinar disponibilidad.</p>
                          <div className="mt-2 flex gap-2">
                            <a className="px-3 py-2 rounded-lg bg-green-600 text-white transition hover:opacity-95" href={WHATSAPP_URL} target="_blank" rel="noopener">Contactar por WhatsApp</a>
                            <button className="px-3 py-2 rounded-lg border" onClick={() => setTab('book')}>Ir a reservar</button>
                          </div>
                          <p className="text-xs text-gray-600 mt-2">Regla: solo se permiten cambios con al menos 24 horas de anticipación.</p>
                        </>
                      ) : (
                        <>
                          <div className="font-medium">No es posible cambiar la reserva.</div>
                          <p>Faltan menos de 24 horas para tu clase. Si necesitas ayuda, contáctanos por WhatsApp.</p>
                          <a className="inline-block mt-2 px-3 py-2 rounded-lg bg-green-600 text-white transition hover:opacity-95" href={WHATSAPP_URL} target="_blank" rel="noopener">Contactar por WhatsApp</a>
                        </>
                      )}
                    </div>
                  </div>
                );
              })()}
            </section>
          </Fade>
        )}
      </main>

      {/* MODAL: Confirmación (muestra precio final) */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-30 transition-opacity duration-300">
          <div className="bg-white w-full max-w-md rounded-2xl p-6 shadow-xl space-y-4 transition-transform duration-300 will-change-transform">
            <h3 className="text-lg font-semibold">Confirmar reserva</h3>

            {/* Paso 1: datos del padre/estudiante */}
{confirmStep === 1 && (
  <>
    <div className="text-sm text-gray-700 space-y-1">
      <div><b>Tipo:</b> {bookingMode === 'individual' ? 'Clase individual' : `Paquete de ${selectedPackage} horas`}</div>
      <div><b>Tutor:</b> {tutorMap[selectedTutorForPkg || singleSelectedSlot?.tutorId]?.name}</div>
      <div><b>Modalidad:</b> {selectedModalidadForPkg || singleSelectedSlot?.modalidad}</div>
      <div className="max-h-28 overflow-auto">
        <b>Horario(s):</b>
        <ul className="list-disc ml-5">
          {selectedSlots.map(id => {
            const s = slots.find(x => x.id === id);
            if (!s) return null;
            return <li key={id}>{fmtDateLongEs(s.dateISO)} • {s.start}–{s.end}</li>;
          })}
        </ul>
      </div>
    </div>

    <div className="space-y-3 mt-2">
      <input className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400" placeholder="Nombre del padre/madre" value={bookingForm.parentName} onChange={e => setBookingForm(f => ({ ...f, parentName: e.target.value }))} />
      <input className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400" type="email" placeholder="Correo electrónico" value={bookingForm.email} onChange={e => setBookingForm(f => ({ ...f, email: e.target.value }))} />
      <input className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400" placeholder="Nombre del estudiante" value={bookingForm.student} onChange={e => setBookingForm(f => ({ ...f, student: e.target.value }))} />
      <input className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400" placeholder="Materia(s) a estudiar (ej. Matemáticas, Inglés)" value={bookingForm.subjects} onChange={e => setBookingForm(f => ({ ...f, subjects: e.target.value }))} />
      <input className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400" placeholder="Temas específicos (opcional)" value={bookingForm.topics} onChange={e => setBookingForm(f => ({ ...f, topics: e.target.value }))} />
      <textarea className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400" rows={3} placeholder="Notas (opcional)" value={bookingForm.notes} onChange={e => setBookingForm(f => ({ ...f, notes: e.target.value }))} />
    </div>

    <div className="flex justify-end gap-2 mt-2">
      <button className="px-3 py-2 rounded-lg border bg-white transition duration-300 hover:opacity-95 active:scale-[0.99]" onClick={() => setShowConfirm(false)}>Cancelar</button>
      <button
        className="px-3 py-2 rounded-lg bg-indigo-600 text-white transition duration-300 hover:opacity-95 active:scale-[0.99]"
        onClick={() => {
          if (!bookingForm.parentName.trim() || !bookingForm.email.trim() || !bookingForm.student.trim()) {
            alert('Por favor completa nombre del padre/madre, correo y nombre del estudiante.');
            return;
          }
          setConfirmStep(2);
        }}
      >
        Continuar
      </button>
    </div>
  </>
)}

{/* Paso 2: confirmación + pago */}
{confirmStep === 2 && (
  <>
    <div className="text-sm text-gray-700 space-y-1">
      <div><b>Tipo:</b> {bookingMode === 'individual' ? 'Clase individual' : `Paquete de ${selectedPackage} horas`}</div>
      <div><b>Tutor:</b> {tutorMap[selectedTutorForPkg || singleSelectedSlot?.tutorId]?.name}</div>
      <div><b>Modalidad:</b> {selectedModalidadForPkg || singleSelectedSlot?.modalidad}</div>
      <div><b>Estudiante:</b> {bookingForm.student}</div>
      <div><b>Padre/Madre:</b> {bookingForm.parentName} ({bookingForm.email})</div>
      {bookingForm.subjects && <div><b>Materia(s):</b> {bookingForm.subjects}</div>}
      {bookingForm.topics && <div><b>Temas:</b> {bookingForm.topics}</div>}
      <div className="max-h-28 overflow-auto">
        <b>Horario(s):</b>
        <ul className="list-disc ml-5">
          {selectedSlots.map(id => {
            const s = slots.find(x => x.id === id);
            if (!s) return null;
            return <li key={id}>{fmtDateLongEs(s.dateISO)} • {s.start}–{s.end}</li>;
          })}
        </ul>
      </div>

      {/* Precio final */}
      <div className="mt-2 p-3 rounded-lg bg-indigo-50">
        <div><b>Total:</b> {totalInfo.amount ? `$${fmtCOP(totalInfo.amount)}` : '—'}</div>
        {totalInfo.note && <div className="text-xs text-gray-600">{totalInfo.note}</div>}
      </div>
    </div>

    {/* Pago */}
    <div className="mt-3 rounded-lg border p-3 bg-white">
      <div className="font-medium mb-2">Pago</div>
      <p className="text-sm text-gray-600">Escanea el QR de Bancolombia para pagar. Luego ingresa el número de referencia o adjunta el comprobante. Verificaremos manualmente.</p>
      <div className="mt-3 flex items-center gap-3">
        <img src="/qr-bancolombia.png" alt="QR Bancolombia" className="w-40 h-40 object-contain border rounded-md bg-white" />
        <div className="flex-1">
          <input
            className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            placeholder="Referencia de pago (opcional)"
            value={bookingForm.paymentRef}
            onChange={e => setBookingForm(f => ({ ...f, paymentRef: e.target.value }))}
          />
          <input
            type="file"
            accept="image/*,application/pdf"
            className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400 mt-2"
            onChange={(e) => setPaymentFile(e.target.files?.[0] || null)}
          />
          <p className="text-xs text-gray-500 mt-1">Puedes adjuntar una imagen o PDF del comprobante (máx. 5 MB).</p>
        </div>
      </div>
    </div>

    <div className="flex justify-between gap-2 mt-3">
      <button className="px-3 py-2 rounded-lg border bg-white transition duration-300 hover:opacity-95 active:scale-[0.99]" onClick={() => setConfirmStep(1)}>Atrás</button>
      <button
        className="px-3 py-2 rounded-lg bg-indigo-600 text-white transition duration-300 hover:opacity-95 active:scale-[0.99] disabled:opacity-50"
        onClick={confirmBooking}
        disabled={submitting}
      >
        {submitting ? 'Confirmando…' : 'Confirmar'}
      </button>
    </div>
  </>
)}

{/* Paso 3: éxito */}
{confirmStep === 3 && (
  <div className="text-center space-y-3">
    <div className="text-2xl font-semibold">¡Reserva confirmada!</div>
    <p className="text-gray-700">Revisa tu correo: te enviamos la confirmación con los detalles de tu clase.</p>
    <button className="mt-2 px-3 py-2 rounded-lg bg-indigo-600 text-white transition duration-300 hover:opacity-95 active:scale-[0.99]" onClick={() => setShowConfirm(false)}>Cerrar</button>
  </div>
  
)}
        </div>
      </div>
    )}

    {showLogin && !isTutor && (
  <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-30 transition-opacity duration-300">
    <div className="bg-white w-full max-w-sm rounded-2xl p-6 shadow-xl space-y-4 transition-transform duration-300 will-change-transform">
      <h3 className="text-lg font-semibold">Ingreso de tutor</h3>
      <input
        type="email"
        placeholder="Correo del tutor"
        className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        value={loginEmail}
        onChange={e => setLoginEmail(e.target.value)}
      />
      <input
        type="password"
        placeholder="Contraseña"
        className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        value={loginPassword}
        onChange={e => setLoginPassword(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <button
          className="px-3 py-2 rounded-lg border bg-white transition duration-300 hover:opacity-95 active:scale-[0.99]"
          onClick={() => { setShowLogin(false); setLoginEmail(''); setLoginPassword(''); }}
        >
          Cancelar
        </button>
        <button
          className="px-3 py-2 rounded-lg bg-indigo-600 text-white transition duration-300 hover:opacity-95 active:scale-[0.99]"
          onClick={login}
        >
          Entrar
        </button>
      </div>
    </div> 
  </div>
)}

      <footer className="py-10 text-center text-xs text-gray-500">
        Hecho con ❤️ Lumina
      </footer>
    </div>
  );
}