import React, { useEffect, useMemo, useState } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getFirestore, collection, addDoc, updateDoc, deleteDoc, doc,
  onSnapshot, getDocs, writeBatch
} from 'firebase/firestore';

import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';

// ---------- utilidades ----------
const uid = () => (crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const toISODate = (d) => new Date(d).toISOString();
const formatTime = (t) => t.padStart(5, '0');
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const fmtCOP = (n) => n?.toLocaleString('es-CO');
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY,
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FB_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FB_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FB_SENDER_ID,
  appId: import.meta.env.VITE_FB_APP_ID,
  measurementId: import.meta.env.VITE_FB_MEASUREMENT_ID,
};
const appFB = initializeApp(firebaseConfig);
const db = getFirestore(appFB);

const auth = getAuth(appFB);

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
    <div className={`transition-opacity duration-[${duration}] ${visible ? 'opacity-100' : 'opacity-0'} ${className}`}>
      {children}
    </div>
  );
}

export default function App() {
  // pestañas: home | prices | team | book | tutor | admin
  const [tab, setTab] = useState('home');

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
  const [newTutorBio, setNewTutorBio] = useState('');

  // Admin: editar tutor
  const [editTutorId, setEditTutorId] = useState('');
  const [editTutorName, setEditTutorName] = useState('');
  const [editTutorPhoto, setEditTutorPhoto] = useState('');
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
  const [bookingForm, setBookingForm] = useState({ parentName: '', email: '', student: '', notes: '' });

  // cargar / persistir
  useEffect(() => {
    const unsubTutors = onSnapshot(collection(db, 'tutors'), (snap) => {
      setTutors(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    const unsubSlots = onSnapshot(collection(db, 'slots'), (snap) => {
      setSlots(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    const unsubBookings = onSnapshot(collection(db, 'bookings'), (snap) => {
      setBookings(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    useEffect(() => {
  const unsub = onAuthStateChanged(auth, (user) => {
    setIsTutor(!!user);
    // opcional: persistir banderita para la UI
    localStorage.setItem(LS.IS_TUTOR, user ? '1' : '0');
  });
  return () => unsub();
}, []);

    const storedTutor = localStorage.getItem(LS.IS_TUTOR) === '1';
    setIsTutor(storedTutor);

    return () => {
      unsubTutors();
      unsubSlots();
      unsubBookings();
    };
  }, []);
  useEffect(() => { localStorage.setItem(LS.IS_TUTOR, isTutor ? '1' : '0'); }, [isTutor]);

  // Precargar el formulario de edición cuando cambia el tutor seleccionado
  useEffect(() => {
    if (!editTutorId) {
      setEditTutorName('');
      setEditTutorPhoto('');
      setEditTutorBio('');
      return;
    }
    const t = tutors.find(t => t.id === editTutorId);
    if (t) {
      setEditTutorName(t.name || '');
      setEditTutorPhoto(t.photo || '');
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
    if (!name) return;
    const photo = newTutorPhoto.trim() || '/tutores/default.jpg';
    const bio = newTutorBio.trim() || 'Tutor/a de Lumina.';
    addDoc(collection(db, 'tutors'), { name, photo, bio })
      .then(() => {
        setNewTutorName(''); setNewTutorPhoto(''); setNewTutorBio('');
      })
      .catch((e) => alert('Error al agregar tutor: ' + e.message));
  };

  const addSlot = () => {
    const { tutorId, date, start, end, modalidad } = newSlot;
    if (!tutorId || !date || !start || !end || !modalidad) return alert('Completa todos los campos.');
    if (end <= start) return alert('La hora de fin debe ser posterior a la de inicio.');
    const slot = { tutorId, dateISO: toISODate(date), start: formatTime(start), end: formatTime(end), booked: false, modalidad };
    addDoc(collection(db, 'slots'), slot)
      .then(() => setNewSlot({ tutorId: '', date: '', start: '', end: '', modalidad: 'presencial' }))
      .catch((e) => alert('Error al agregar disponibilidad: ' + e.message));
  };

  const removeSlot = (id) => {
    deleteDoc(doc(db, 'slots', id)).catch((e) => alert('Error al eliminar: ' + e.message));
  };

  // listas filtradas
  const availableSlots = useMemo(() => {
    let s = slots.filter(s => !s.booked);
    if (filterTutorId)     s = s.filter(x => x.tutorId === filterTutorId);
    if (filterDate)        s = s.filter(x => sameDay(x.dateISO, filterDate));
    if (filterModalidad)   s = s.filter(x => x.modalidad === filterModalidad);
    return s.sort((a,b) => (a.dateISO + a.start).localeCompare(b.dateISO + b.start));
  }, [slots, filterTutorId, filterDate, filterModalidad]);

  // elegibles para paquete (mismo tutor + misma modalidad)
  const pkgEligibleSlots = useMemo(() => {
    let s = slots.filter(s => !s.booked);
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
  };

  // abrir confirm para paquete
  const openConfirmPackage = () => {
    if (!selectedTutorForPkg || !selectedModalidadForPkg) return alert('Selecciona tutor y modalidad.');
    if (selectedSlots.length !== selectedPackage) return alert(`Debes elegir exactamente ${selectedPackage} horario(s).`);
    setSingleSelectedSlot(null);
    setBookingMode('paquete');
    setShowConfirm(true);
  };

  // confirmar reserva
  const confirmBooking = () => {
    const { parentName, email, student, notes } = bookingForm;
    if (!parentName.trim() || !email.trim() || !student.trim()) return alert('Por favor completa nombre del padre/madre, correo y nombre del estudiante.');

    try {
      const batch = writeBatch(db);
      // marcar slots como reservados
      selectedSlots.forEach(id => {
        batch.update(doc(db, 'slots', id), { booked: true });
      });
      // crear reserva
      const bookingRef = doc(collection(db, 'bookings'));
      batch.set(bookingRef, {
        slotIds: selectedSlots.slice(),
        tutorId: selectedTutorForPkg,
        modalidad: selectedModalidadForPkg,
        hours: bookingMode === 'individual' ? 1 : selectedPackage,
        mode: bookingMode,
        parentName: parentName.trim(),
        email: email.trim(),
        student: student.trim(),
        notes: (notes || '').trim(),
        createdAtISO: new Date().toISOString(),
      });
      batch.commit().then(() => {
        setSelectedSlots([]);
        setSingleSelectedSlot(null);
        setBookingForm({ parentName: '', email: '', student: '', notes: '' });
        setShowConfirm(false);
        alert('¡Reserva confirmada!');
      }).catch((e) => alert('Error al confirmar: ' + e.message));
    } catch (e) {
      alert('Error al confirmar: ' + e.message);
    }
  };

  // cancelar desde admin
  const cancelBooking = (bookingId) => {
    const booking = bookings.find(b => b.id === bookingId);
    if (!booking) return;
    const batch = writeBatch(db);
    booking.slotIds.forEach(id => {
      batch.update(doc(db, 'slots', id), { booked: false });
    });
    batch.delete(doc(db, 'bookings', bookingId));
    batch.commit().catch((e) => alert('Error al cancelar: ' + e.message));
  };

  // total a mostrar en el modal
  const totalInfo = (() => {
    const hours = bookingMode === 'individual' ? 1 : selectedPackage;
    const modalidad = selectedModalidadForPkg || singleSelectedSlot?.modalidad || 'presencial';
    return computeTotal({ mode: bookingMode, modalidad, hours });
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
                  </ul>
                </div>
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
                        <div className="text-sm text-gray-500">{new Date(s.dateISO).toLocaleDateString('es-ES')}</div>
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
                          <div className="text-sm text-gray-500">{new Date(s.dateISO).toLocaleDateString('es-ES')}</div>
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
          <Fade>
          <section className="space-y-8">
            <h2 className="text-xl font-semibold">Portal de tutores</h2>

            {/* Agregar tutor */}
            <div className="rounded-2xl border bg-white p-4 space-y-2">
              <h3 className="font-medium">Agregar tutor</h3>
              <div className="grid sm:grid-cols-3 gap-2">
                <input className="border rounded-lg px-3 py-2" placeholder="Nombre del tutor" value={newTutorName} onChange={e => setNewTutorName(e.target.value)} />
                <input className="border rounded-lg px-3 py-2" placeholder="Foto (ruta, ej: /tutores/ana.jpg)" value={newTutorPhoto} onChange={e => setNewTutorPhoto(e.target.value)} />
                <input className="border rounded-lg px-3 py-2" placeholder="Breve descripción" value={newTutorBio} onChange={e => setNewTutorBio(e.target.value)} />
              </div>
              <button className="mt-2 px-3 py-2 rounded-lg bg-indigo-600 text-white transition duration-300 hover:opacity-95 active:scale-[0.99]" onClick={addTutor}>Agregar</button>
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
                  {slots.map(s => (
                    <li key={s.id} className="flex items-center justify-between border rounded-lg bg-white px-3 py-2">
                      <div className="text-sm">
                        <span className="text-gray-500">{new Date(s.dateISO).toLocaleDateString('es-ES')}</span>
                        {' • '}<span>{s.start}–{s.end}</span>
                        {' • '}<span className="font-medium">{tutorMap[s.tutorId]?.name}</span>
                        {' • '}<span className="text-gray-600 capitalize">{s.modalidad}</span>
                        {s.booked && <span className="ml-2 text-green-700 font-medium">(reservado)</span>}
                      </div>
                      <button className="text-red-700 hover:underline transition duration-300" onClick={() => removeSlot(s.id)}>eliminar</button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
          </Fade>
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
              <div className="grid sm:grid-cols-4 gap-2">
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
                  placeholder="Foto (ruta, ej: /tutores/ana.jpg)"
                  value={editTutorPhoto}
                  onChange={e => setEditTutorPhoto(e.target.value)}
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
                    const photo = editTutorPhoto.trim() || '/tutores/default.jpg';
                    const bio = editTutorBio.trim() || 'Tutor/a de Lumina.';
                    updateDoc(doc(db, 'tutors', editTutorId), { name, photo, bio })
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
                    <th className="px-4 py-2">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.length === 0 && (
                    <tr><td colSpan="9" className="px-4 py-3 text-gray-600">Aún no hay reservas.</td></tr>
                  )}
                  {bookings.map(b => {
                    const t = tutorMap[b.tutorId];
                    const slotList = b.slotIds.map(id => slots.find(s => s.id === id)).filter(Boolean);
                    const when = slotList.map(s => `${new Date(s.dateISO).toLocaleDateString('es-ES')} ${s.start}–${s.end}`).join(' | ');
                    return (
                      <tr key={b.id} className="border-b align-top">
                        <td className="px-4 py-2 text-sm capitalize">{b.mode || '—'}</td>
                        <td className="px-4 py-2 text-sm">{t?.name}</td>
                        <td className="px-4 py-2 text-sm capitalize">{b.modalidad}</td>
                        <td className="px-4 py-2 text-sm">{b.hours}</td>
                        <td className="px-4 py-2 text-sm">{when}</td>
                        <td className="px-4 py-2 text-sm">{b.student}</td>
                        <td className="px-4 py-2 text-sm">{b.parentName}</td>
                        <td className="px-4 py-2 text-sm">{b.email}</td>
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
      </main>

      {/* MODAL: Confirmación (muestra precio final) */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-30 transition-opacity duration-300">
          <div className="bg-white w-full max-w-md rounded-2xl p-6 shadow-xl space-y-4 transition-transform duration-300 will-change-transform">
            <h3 className="text-lg font-semibold">Confirmar reserva</h3>

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
                    return <li key={id}>{new Date(s.dateISO).toLocaleDateString('es-ES')} • {s.start}–{s.end}</li>;
                  })}
                </ul>
              </div>

              {/* Precio final */}
              <div className="mt-2 p-3 rounded-lg bg-indigo-50">
                <div><b>Total:</b> {totalInfo.amount ? `$${fmtCOP(totalInfo.amount)}` : '—'}</div>
                {totalInfo.note && <div className="text-xs text-gray-600">{totalInfo.note}</div>}
              </div>
            </div>

            {/* Form del padre */}
            <div className="space-y-3">
              <input className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400" placeholder="Nombre del padre/madre" value={bookingForm.parentName} onChange={e => setBookingForm(f => ({ ...f, parentName: e.target.value }))} />
              <input className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400" type="email" placeholder="Correo electrónico" value={bookingForm.email} onChange={e => setBookingForm(f => ({ ...f, email: e.target.value }))} />
              <input className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400" placeholder="Nombre del estudiante" value={bookingForm.student} onChange={e => setBookingForm(f => ({ ...f, student: e.target.value }))} />
              <textarea className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400" rows={3} placeholder="Notas (opcional)" value={bookingForm.notes} onChange={e => setBookingForm(f => ({ ...f, notes: e.target.value }))} />
            </div>

            <div className="flex justify-end gap-2">
              <button className="px-3 py-2 rounded-lg border bg-white transition duration-300 hover:opacity-95 active:scale-[0.99]" onClick={() => setShowConfirm(false)}>Volver</button>
              <button className="px-3 py-2 rounded-lg bg-indigo-600 text-white transition duration-300 hover:opacity-95 active:scale-[0.99]" onClick={confirmBooking}>Confirmar</button>
            </div>
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