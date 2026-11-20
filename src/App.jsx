import { useEffect, useMemo, useRef, useState } from 'react'
import Plot from 'react-plotly.js'
import Plotly from 'plotly.js/dist/plotly'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { supabase } from './lib/supabase'

const PROFIL_LABELS = {
  generique: 'Générique',
  aile_2d: 'Aile 2D',
  interne: 'Écoulement interne',
}

const STATUT_STYLES = {
  complete: { label: 'Complète', bg: '#dcfce7', color: '#166534' },
  partielle: { label: 'Partielle', bg: '#fef3c7', color: '#92400e' },
  en_cours: { label: 'En cours', bg: '#dbeafe', color: '#1e40af' },
  erreur: { label: 'Erreur', bg: '#fee2e2', color: '#991b1b' },
}

const CONV_STYLES = {
  converge: { label: 'Convergé', bg: '#dcfce7', color: '#166534', pdfRgb: [220, 252, 231] },
  limite: { label: 'Limite', bg: '#fef3c7', color: '#92400e', pdfRgb: [254, 243, 199] },
  non_converge: { label: 'Non convergé', bg: '#fee2e2', color: '#991b1b', pdfRgb: [254, 226, 226] },
  periodique: { label: 'Périodique', bg: '#e0e7ff', color: '#3730a3', pdfRgb: [224, 231, 255] },
  oscillant: { label: 'Périodique', bg: '#e0e7ff', color: '#3730a3', pdfRgb: [224, 231, 255] },
  instabilite: { label: 'Amplitude croissante', bg: '#fee2e2', color: '#991b1b', pdfRgb: [254, 226, 226] },
  imposee: { label: 'Imposée', bg: '#f1f5f9', color: '#475569', pdfRgb: [241, 245, 249] },
  indetermine: { label: 'Indéterminé', bg: '#f1f5f9', color: '#64748b', pdfRgb: [241, 245, 249] },
  constante: { label: 'Constante', bg: '#e2e8f0', color: '#475569', pdfRgb: [226, 232, 240] },
}

const META_CONFIG = {
  profil: { label: 'Profil', unite: '' },
  corde: { label: 'Corde c', unite: 'm' },
  longueur_ref: { label: 'Longueur réf. L_réf', unite: 'm' },
  vitesse_amont: { label: 'Vitesse amont V∞', unite: 'm/s' },
  vitesse_ref: { label: 'Vitesse réf. V_réf', unite: 'm/s' },
  rho: { label: 'Masse volumique ρ', unite: 'kg/m³' },
  mu: { label: 'Viscosité dynamique μ', unite: 'Pa·s' },
  alpha: { label: 'Angle d’attaque α', unite: '°' },
  turbulence: { label: 'Modèle de turbulence', unite: '' },
  nb_cellules: { label: 'Nombre de cellules', unite: '' },
  fluide: { label: 'Fluide', unite: '' },
  regime: { label: 'Régime', unite: '' },
  regime_temporel: { label: 'Régime temporel', unite: '' },
  abscisse: { label: 'Abscisse', unite: '' },
  dt: { label: 'Pas de temps Δt', unite: 's' },
  composant: { label: 'Composant', unite: '' },
  diametre_hydraulique: { label: 'Diamètre hydraulique Dh', unite: 'm' },
  condition_entree: { label: 'Condition d’entrée', unite: '' },
  condition_sortie: { label: 'Condition de sortie', unite: '' },
  longueur_entree_dh: { label: 'Longueur entrée', unite: 'Dh' },
  longueur_sortie_dh: { label: 'Longueur sortie', unite: 'Dh' },
  taille_domaine_cordes: { label: 'Taille domaine', unite: 'cordes' },
  temperature: { label: 'Température T', unite: 'K' },
}

const CHAMPS_EDITION_PAR_PROFIL = {
  aile_2d: ['profil', 'corde', 'vitesse_amont', 'rho', 'mu', 'alpha', 'temperature', 'dt', 'taille_domaine_cordes'],
  interne: ['composant', 'fluide', 'diametre_hydraulique', 'vitesse_ref', 'rho', 'mu', 'temperature', 'longueur_entree_dh', 'longueur_sortie_dh'],
  generique: ['longueur_ref', 'vitesse_ref', 'fluide', 'rho', 'mu', 'temperature', 'dt'],
}

const ROLE_LABELS = { entree: 'entrée', inlet: 'entrée', sortie: 'sortie', outlet: 'sortie', paroi: 'paroi', wall: 'paroi', symetrie: 'symétrie' }
const COLONNES_ABSCISSE = ['flow-time', 'flow_time', 'time', 'temps', 'iteration', 'iter', 'step', 'time step', 'time-step']
const PLOTLY_COLORS = ['#2563eb', '#ea580c', '#16a34a', '#9333ea', '#dc2626', '#0891b2']

function formaterNombre(val) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return '—'
  const n = Number(val)
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs < 1e-3 || abs >= 1e6) return n.toExponential(3).replace('.', ',')
  return Number(n.toPrecision(5)).toLocaleString('fr-FR', { maximumSignificantDigits: 5 })
}

function formaterTexteMeta(k, v) {
  if (typeof v === 'number') return formaterNombre(v)
  const s = String(v)
  if (k === 'turbulence') return s.replace(/k-omega/gi, 'k-ω').replace(/k-epsilon/gi, 'k-ε')
  return s
}

function normaliserKpi(val) {
  if (val !== null && typeof val === 'object' && 'valeur' in val) return val
  return {
    valeur: typeof val === 'number' ? val : Number(val),
    moyenne_significative: true,
    ecart_type: null,
    rms: null,
    amplitude: null,
    frequence_hz: null,
    strouhal: null,
    variation_rel_pct: null,
    unite: '-',
    methode: 'moyenne_finale',
    fenetre: 50,
    convergence: null,
    source: 'legacy',
  }
}

function trouverValeurKpi(kpiFinaux, alias) {
  if (!kpiFinaux) return null
  for (const [k, v] of Object.entries(kpiFinaux)) {
    const kl = k.toLowerCase()
    if (alias.some((a) => kl === a || kl.includes(a))) {
      const n = normaliserKpi(v).valeur
      return Number.isNaN(n) ? null : n
    }
  }
  return null
}

function deduireGroupeGrandeur(nomCol) {
  const c = nomCol.toLowerCase()
  if (c.includes('pressure') || c.includes('pression') || c.includes('dp') || c.startsWith('p_') || c.startsWith('p0_')) return { id: 'pression', titre: 'Pressions (Pa)', unite: 'Pa' }
  if (c.includes('mass-flow') || c.includes('debit') || c.includes('mdot') || c.includes('m_in') || c.includes('m_out')) return { id: 'debit', titre: 'Débits massiques (kg/s)', unite: 'kg/s' }
  if (c.includes('temp') || c.startsWith('t_')) return { id: 'temperature', titre: 'Températures (K)', unite: 'K' }
  if (c.includes('velocity') || c.includes('vitesse')) return { id: 'vitesse', titre: 'Vitesses (m/s)', unite: 'm/s' }
  if (c.includes('residual') || c.includes('residu') || c.includes('continuity')) return { id: 'residus', titre: 'Résidus du solveur', unite: 'Résidu' }
  return { id: 'coeffs', titre: 'Évolution des grandeurs suivies', unite: 'Valeur' }
}

function extraireAxes(donnees, abscisseDeclaree = null) {
  const cles = donnees.length > 0 ? Object.keys(donnees[0]) : []
  if (cles.length === 0) return { axeX: null, labelX: '', isIntegerX: false, nbPoints: 0, variablesY: [] }

  let axeX = abscisseDeclaree && cles.includes(abscisseDeclaree) ? abscisseDeclaree : (
    cles.find((c) => c.toLowerCase().includes('flow-time') || c.toLowerCase().includes('flow_time')) ||
    cles.find((c) => c.toLowerCase() === 'time' || c.toLowerCase() === 'temps') ||
    cles.find((c) => c.toLowerCase().includes('iter')) ||
    cles.find((c) => c.toLowerCase().includes('step')) ||
    cles[0]
  )

  const variablesY = cles.filter((cle) => cle !== axeX && !COLONNES_ABSCISSE.includes(cle.toLowerCase().trim()))
  const axLow = axeX.toLowerCase()
  const isIntegerX = axLow.includes('iter') || axLow.includes('step')
  const labelX = axLow.includes('time') && !axLow.includes('step') ? 'Flow Time (s)' : axeX
  return { axeX, labelX, isIntegerX, nbPoints: donnees.length, variablesY }
}

function grouperVariablesParGrandeur(variablesY) {
  const groupes = {}
  for (const v of variablesY) {
    const g = deduireGroupeGrandeur(v)
    if (!groupes[g.id]) groupes[g.id] = { ...g, vars: [] }
    groupes[g.id].vars.push(v)
  }
  return Object.values(groupes)
}

function appliquerMoyenneGlissante(vals, fenetre) {
  if (!fenetre || fenetre <= 1) return vals
  return vals.map((_, i) => {
    const start = Math.max(0, i - fenetre + 1)
    let sum = 0
    for (let j = start; j <= i; j++) sum += vals[j]
    return sum / (i - start + 1)
  })
}

function regressionLineaire(xs, ys) {
  const n = xs.length
  if (n < 2) return null
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  if (Math.abs(den) < 1e-12) return null
  const pente = num / den
  return { pente, ordonnee: my - pente * mx }
}

// Ajustement quadratique ΔP = a * Q^2 avec calcul du coefficient R² (REV-39)
function ajustementQuadratiqueAvecR2(qs, dps) {
  let num = 0, den = 0
  for (let i = 0; i < qs.length; i++) {
    const q2 = qs[i] * qs[i]
    num += q2 * dps[i]
    den += q2 * q2
  }
  if (Math.abs(den) < 1e-12) return null
  const a = num / den
  const meanY = dps.reduce((acc, v) => acc + v, 0) / dps.length
  let ssRes = 0, ssTot = 0
  for (let i = 0; i < qs.length; i++) {
    const pred = a * qs[i] * qs[i]
    ssRes += (dps[i] - pred) ** 2
    ssTot += (dps[i] - meanY) ** 2
  }
  const r2 = ssTot > 1e-12 ? 1 - ssRes / ssTot : 1
  return { a, r2 }
}

// Estimation de fréquence dominante par DFT simple (pour signaux périodiques en import local — REV-44)
function estimerFrequenceDFT(vals, dt) {
  if (!dt || dt <= 0 || vals.length < 16) return { freqHz: null, nbPeriodes: null, moyPeriodes: null }
  const N = vals.length
  const mean = vals.reduce((a, b) => a + b, 0) / N
  const centered = vals.map((v) => v - mean)
  let maxMag = 0, bestK = 0
  const maxK = Math.floor(N / 2)
  for (let k = 1; k <= maxK; k++) {
    let re = 0, im = 0
    for (let n = 0; n < N; n++) {
      const ang = (2 * Math.PI * k * n) / N
      re += centered[n] * Math.cos(ang)
      im -= centered[n] * Math.sin(ang)
    }
    const mag = Math.hypot(re, im)
    if (mag > maxMag) {
      maxMag = mag
      bestK = k
    }
  }
  if (bestK === 0) return { freqHz: null, nbPeriodes: null, moyPeriodes: null }
  const freqHz = bestK / (N * dt)
  const nbPeriodes = N * dt * freqHz
  let moyPeriodes = null
  if (nbPeriodes >= 2) {
    const nEntier = Math.round(Math.floor(nbPeriodes) / (freqHz * dt))
    if (nEntier >= 10 && nEntier <= N) {
      const slice = vals.slice(-nEntier)
      moyPeriodes = slice.reduce((a, b) => a + b, 0) / slice.length
    }
  }
  return { freqHz: Number(freqHz.toFixed(4)), nbPeriodes: Number(nbPeriodes.toFixed(2)), moyPeriodes }
}

function estLigneNumerique(ligne) {
  const tokens = ligne.trim().split(/[\s,;]+/).filter(Boolean)
  if (tokens.length < 2) return false
  return tokens.every((t) => !Number.isNaN(Number(t)))
}

function parserFichierFluent(texte, nomFichier = 'local') {
  const lignes = texte.split(/\r?\n/)
  const debutDonnees = lignes.findIndex((l) => estLigneNumerique(l))
  if (debutDonnees === -1) throw new Error('Aucune donnée numérique détectée dans ce fichier.')

  let colonnes = null
  for (let i = debutDonnees - 1; i >= 0; i--) {
    const lStrip = lignes[i].trim()
    if (!lStrip) continue
    if (lStrip.startsWith('(') && lStrip.endsWith(')')) {
      const matches = [...lStrip.matchAll(/"([^"]+)"/g)].map((m) => m[1])
      if (matches.length > 0) { colonnes = matches; break }
    }
    const lClean = lStrip.replace(/^[#%]+/, '').trim()
    if (lClean && !lClean.startsWith('"Report')) {
      const candidats = lClean.split(/[\t,;]+|\s{2,}/).map((c) => c.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      if (candidats.length >= 2) { colonnes = candidats; break }
    }
  }

  const ligneRef = lignes[debutDonnees].trim()
  const sepRegex = ligneRef.includes(',') ? /,/ : ligneRef.includes(';') ? /;/ : /\s+/
  const lignesValides = []
  for (let i = debutDonnees; i < lignes.length; i++) {
    const l = lignes[i].trim()
    if (!l) continue
    const vals = l.split(sepRegex).filter(Boolean).map(Number)
    if (vals.length >= 2 && vals.every((v) => !Number.isNaN(v))) lignesValides.push(vals)
  }
  if (lignesValides.length === 0) throw new Error('Impossible de lire les valeurs numériques du fichier.')

  const nbCols = lignesValides[0].length
  const nomsColonnes = colonnes && colonnes.length === nbCols ? colonnes : Array.from({ length: nbCols }, (_, idx) => `Col_${idx}`)
  const donnees = lignesValides.filter((row) => row.length === nbCols).map((row) => {
    const obj = {}
    nomsColonnes.forEach((col, idx) => { obj[col] = row[idx] })
    return obj
  })

  const { axeX, variablesY } = extraireAxes(donnees)
  const isTimeAxis = axeX.toLowerCase().includes('time') && !axeX.toLowerCase().includes('step')
  let dt = null
  if (isTimeAxis && donnees.length >= 2) {
    const diffs = []
    for (let i = 1; i < donnees.length; i++) {
      const d = donnees[i][axeX] - donnees[i - 1][axeX]
      if (d > 0) diffs.push(d)
    }
    if (diffs.length > 0) dt = diffs[Math.floor(diffs.length / 2)]
  }

  const kpiFinaux = {}
  // REV-45 : fenêtre adaptative = 20 % finaux (min 20 pts)
  const nWin = Math.min(donnees.length, Math.max(20, Math.round(0.2 * donnees.length)))
  const sliceFin = donnees.slice(-nWin)

  for (const col of variablesY) {
    const allVals = donnees.map((r) => r[col])
    const vals = sliceFin.map((r) => r[col])
    let mean = vals.reduce((a, b) => a + b, 0) / vals.length
    const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length)
    const rms = Math.sqrt(vals.reduce((a, b) => a + b * b, 0) / vals.length)
    const range = Math.max(...vals) - Math.min(...vals)
    const amplitude = range / 2
    const rangeTot = Math.max(...allVals) - Math.min(...allVals)

    let changementsSigne = 0
    for (let i = 1; i < vals.length; i++) {
      if ((vals[i] - mean) * (vals[i - 1] - mean) < 0) changementsSigne++
    }
    const estPeriodique = isTimeAxis && changementsSigne >= 4 && amplitude > 1e-4

    let convergence = 'converge'
    let moyenneSignificative = true
    let freqHz = null, nbPeriodes = null
    let varRelPct = null

    if (rangeTot === 0) {
      convergence = 'constante'
      varRelPct = 0
    } else if (donnees.length < 20) {
      convergence = 'indetermine'
    } else if (estPeriodique) {
      convergence = 'periodique'
      const dft = estimerFrequenceDFT(allVals, dt)
      freqHz = dft.freqHz
      nbPeriodes = dft.nbPeriodes
      if (dft.moyPeriodes !== null) {
        mean = dft.moyPeriodes
        moyenneSignificative = true
      } else {
        moyenneSignificative = false
      }
    } else {
      varRelPct = Number(((range / Math.max(Math.abs(mean), rangeTot, 1e-6)) * 100).toFixed(3))
      convergence = varRelPct <= 0.1 ? 'converge' : varRelPct <= 1.0 ? 'limite' : 'non_converge'
    }

    kpiFinaux[col] = {
      valeur: Number(mean.toFixed(6)),
      moyenne_significative: moyenneSignificative,
      ecart_type: Number(std.toFixed(6)),
      rms: Number(rms.toFixed(6)),
      amplitude: Number(amplitude.toFixed(6)),
      frequence_hz: freqHz,
      nb_periodes: nbPeriodes,
      strouhal: null,
      variation_rel_pct: varRelPct,
      unite: deduireGroupeGrandeur(col).unite === 'Valeur' ? '-' : deduireGroupeGrandeur(col).unite,
      methode: estPeriodique ? 'analyse_periodique' : 'fenetre_adaptative_20pct',
      fenetre: nWin,
      convergence,
      source: `${nomFichier}:${col}`,
    }
  }

  return { donnees, kpiFinaux, axeX, dt }
}

function parserFichierXY(texte, nomFichier, corde = 1) {
  const lignes = texte.split(/\r?\n/)
  const x = [], y = []
  for (const l of lignes) {
    if (!estLigneNumerique(l)) continue
    const parts = l.trim().split(/[\s,;]+/).map(Number)
    if (parts.length >= 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
      x.push(parts[0]); y.push(parts[1])
    }
  }
  if (x.length === 0) throw new Error(`Aucune donnée numérique (X, Y) trouvée dans ${nomFichier}.`)
  const maxX = Math.max(...x)
  const xNorm = corde > 0 && Math.abs(maxX - corde) < 0.1 * corde ? x.map((v) => v / corde) : x
  return { source: nomFichier, x_c: xNorm, valeur: y }
}

function parserPolaireRef(texte, nomFichier) {
  const lignes = texte.split(/\r?\n/)
  const alpha = [], cl = [], cd = []
  for (const l of lignes) {
    if (!estLigneNumerique(l)) continue
    const parts = l.trim().split(/[\s,;]+/).map(Number)
    if (parts.length >= 2) { alpha.push(parts[0]); cl.push(parts[1]); cd.push(parts.length >= 3 ? parts[2] : null) }
  }
  if (alpha.length === 0) throw new Error('Aucune donnée (alpha, Cl, [Cd]) trouvée.')
  return { nom: nomFichier, alpha, cl, cd }
}

function creerLayoutPlotly(
  titre, labelX, labelY, height = 400, yScale = 'linear',
  isIntegerX = false, nbPoints = 0, syncedRangeX = null,
  dualYAxis = false, leftColor = '#2563eb', rightColor = '#ea580c', leftLabel = null, rightLabel = null
) {
  return {
    autosize: true,
    height,
    title: { text: titre, font: { size: 15, color: '#1e293b' } },
    showlegend: true,
    legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.26 },
    xaxis: {
      title: { text: labelX, font: { size: 13, color: '#1e293b' }, standoff: 10 },
      showgrid: true,
      gridcolor: '#e2e8f0',
      ...(isIntegerX ? { tickformat: 'd', ...(nbPoints > 0 && nbPoints <= 20 ? { dtick: 1 } : {}) } : {}),
      ...(syncedRangeX ? { range: syncedRangeX } : {}),
    },
    yaxis: {
      type: yScale,
      title: { text: dualYAxis ? (leftLabel || labelY) : labelY, font: { size: 13, color: dualYAxis ? leftColor : '#1e293b' } },
      tickfont: { color: dualYAxis ? leftColor : '#1e293b' },
      showgrid: true,
      gridcolor: '#e2e8f0',
      zeroline: true,
      zerolinecolor: '#94a3b8',
    },
    ...(dualYAxis
      ? {
          yaxis2: {
            title: { text: rightLabel || 'Axe droit', font: { size: 13, color: rightColor } },
            tickfont: { color: rightColor },
            overlaying: 'y',
            side: 'right',
            showgrid: false,
            zeroline: false,
          },
        }
      : {}),
    paper_bgcolor: '#ffffff',
    plot_bgcolor: '#ffffff',
    font: { color: '#1e293b' },
    margin: { t: 55, r: dualYAxis ? 70 : 25, l: 75, b: 95 },
  }
}

export default function App() {
  // Authentification Supabase (REV-43)
  const [user, setUser] = useState(null)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authError, setAuthError] = useState('')

  const [simulations, setSimulations] = useState([])
  const [loadingSims, setLoadingSims] = useState(true)
  const [selectedSim, setSelectedSim] = useState(null)
  const [convergence, setConvergence] = useState([])

  const [activeTab, setActiveTab] = useState('synthese')
  const [refCpData, setRefCpData] = useState(null)
  const [refPolarData, setRefPolarData] = useState(null)
  const [localParoiOverrides, setLocalParoiOverrides] = useState({})
  const [showGuideFluent, setShowGuideFluent] = useState(false)

  const [showMeta, setShowMeta] = useState(false)
  const [editingMeta, setEditingMeta] = useState(false)
  const [metaDraft, setMetaDraft] = useState({})
  const [saveStatus, setSaveStatus] = useState('')
  const [deleteMsg, setDeleteMsg] = useState('')
  const [renamingLocal, setRenamingLocal] = useState(false)
  const [localNameDraft, setLocalNameDraft] = useState('')

  const [metaOverrides, setMetaOverrides] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cfd_meta_overrides') || '{}') } catch { return {} }
  })
  const [colMappings, setColMappings] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cfd_col_mappings') || '{}') } catch { return {} }
  })
  const [mappingModalTarget, setMappingModalTarget] = useState(null)
  const [mappingModalChoice, setMappingModalChoice] = useState('')
  const [infoBadgeMsg, setInfoBadgeMsg] = useState('')

  const [searchQuery, setSearchQuery] = useState('')
  const [filterProfil, setFilterProfil] = useState('tous')
  const [filterStatut, setFilterStatut] = useState('tous')

  // Contrôles graphiques (Modif #1 : splitPlots pour côte à côte sur une même simulation)
  const [yScale, setYScale] = useState('linear')
  const [smoothingWindow, setSmoothingWindow] = useState(0)
  const [dualYAxis, setDualYAxis] = useState(false)
  const [splitPlots, setSplitPlots] = useState(false)
  const [syncedRangeX, setSyncedRangeX] = useState(null)

  const [excludedPolarIds, setExcludedPolarIds] = useState([])

  const [compareMode, setCompareMode] = useState(false)
  const [selectedSimB, setSelectedSimB] = useState(null)
  const [convergenceB, setConvergenceB] = useState([])

  const [exportingPdf, setExportingPdf] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [isDragging, setIsDragging] = useState(false)

  const activePlotRef = useRef(null)
  const plotDivRefB = useRef(null)
  const polarRefs = useRef({})

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setUser(data?.session?.user || null))
    const { data: listener } = supabase.auth.onAuthStateChange((_ev, session) => {
      setUser(session?.user || null)
    })
    return () => listener?.subscription?.unsubscribe()
  }, [])

  useEffect(() => {
    async function chargerSimulations() {
      setLoadingSims(true)
      const { data, error } = await supabase
        .from('simulations')
        .select('*')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })

      if (!error && data && data.length > 0) {
        setSimulations(data)
        setSelectedSim(data[0])
        if (data.length > 1) setSelectedSimB(data[1])
      }
      setLoadingSims(false)
    }
    chargerSimulations()
  }, [])

  const seConnecter = async (e) => {
    e.preventDefault()
    setAuthError('')
    const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword })
    if (error) setAuthError(error.message)
    else { setShowAuthModal(false); setAuthPassword('') }
  }

  const seDeconnecter = async () => {
    await supabase.auth.signOut()
  }

  const enrichirSimulation = (sim) => {
    if (!sim) return null
    const metaLocal = metaOverrides[sim.id] || {}
    const metadonnees = { ...(sim.metadonnees || {}), ...metaLocal }
    const mapping = colMappings[sim.id] || {}
    const kpiFinaux = {}

    for (const [k, rawV] of Object.entries(sim.kpi_finaux || {})) {
      const kpi = { ...normaliserKpi(rawV) }
      // Calcul dynamique du Strouhal si longueur_ref/corde et vitesse sont renseignés (REV-44)
      const lRef = metadonnees.corde || metadonnees.diametre_hydraulique || metadonnees.longueur_ref
      const vRef = metadonnees.vitesse_amont || metadonnees.vitesse_ref
      if (kpi.frequence_hz && lRef && vRef && Number(vRef) > 0) {
        kpi.strouhal = Number(((kpi.frequence_hz * Number(lRef)) / Number(vRef)).toFixed(4))
      }
      kpiFinaux[k] = kpi
    }

    for (const [role, colOrigine] of Object.entries(mapping)) {
      if (colOrigine && kpiFinaux[colOrigine]) {
        kpiFinaux[role] = { ...kpiFinaux[colOrigine], source: `${colOrigine} (associé)` }
      }
    }

    if (sim.profil_type === 'aile_2d') {
      const { rho, vitesse_amont, corde, mu, temperature } = metadonnees
      if (rho && vitesse_amont && corde && mu && Number(mu) > 0) {
        kpiFinaux.Reynolds = {
          valeur: Number(((Number(rho) * Number(vitesse_amont) * Number(corde)) / Number(mu)).toFixed(1)),
          ecart_type: null, unite: '-', methode: 'calculé (ρ·V∞·c / μ)', fenetre: 0, convergence: 'imposee', source: 'métadonnées',
        }
      }
      if (vitesse_amont) {
        const tempFournie = temperature !== undefined && temperature !== ''
        const tK = Number(temperature || 288.15)
        kpiFinaux.Mach = {
          valeur: Number((Number(vitesse_amont) / Math.sqrt(1.4 * 287.05 * tK)).toFixed(4)),
          ecart_type: null, unite: '-',
          methode: tempFournie ? `calculé (T = ${tK} K)` : 'calculé (hypothèse T = 288,15 K)',
          hypothese: !tempFournie, fenetre: 0, convergence: 'imposee', source: 'métadonnées',
        }
      }
    }

    const paroiLocal = localParoiOverrides[sim.id] || {}
    return { ...sim, metadonnees, kpi_finaux: kpiFinaux, profils_paroi: { ...(sim.profils_paroi || {}), ...paroiLocal }, hasLocalMeta: Boolean(metaOverrides[sim.id]) }
  }

  const simulationsEnrichies = useMemo(() => simulations.map(enrichirSimulation), [simulations, metaOverrides, colMappings, localParoiOverrides])
  const simActive = useMemo(() => simulationsEnrichies.find((s) => s.id === selectedSim?.id) || null, [simulationsEnrichies, selectedSim])
  const simActiveB = useMemo(() => simulationsEnrichies.find((s) => s.id === selectedSimB?.id) || null, [simulationsEnrichies, selectedSimB])

  useEffect(() => {
    setEditingMeta(false); setRenamingLocal(false); setMetaDraft({}); setSaveStatus(''); setSyncedRangeX(null); setInfoBadgeMsg('')
    if (!simActive) return
    if (simActive.profil_type !== 'aile_2d' && (activeTab === 'paroi' || activeTab === 'polaires')) setActiveTab('synthese')
    if (simActive.profil_type !== 'interne' && (activeTab === 'interne_bilans' || activeTab === 'interne_carac')) setActiveTab('synthese')
  }, [simActive?.id, simActive?.profil_type])

  const simulationsFiltrees = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return simulationsEnrichies.filter((sim) => {
      if (filterProfil !== 'tous' && (sim.profil_type || 'generique') !== filterProfil) return false
      if (filterStatut !== 'tous' && (sim.statut || 'complete') !== filterStatut) return false
      if (!q) return true
      return sim.nom?.toLowerCase().includes(q) || sim.projet?.toLowerCase().includes(q) || (sim.tags || []).some((t) => t.toLowerCase().includes(q))
    })
  }, [simulationsEnrichies, searchQuery, filterProfil, filterStatut])

  useEffect(() => {
    if (simulationsFiltrees.length === 0) setSelectedSim(null)
    else if (!simulationsFiltrees.some((s) => s.id === selectedSim?.id)) setSelectedSim(simulationsFiltrees[0])
  }, [simulationsFiltrees, selectedSim])

  useEffect(() => {
    if (!simActive) { setConvergence([]); return }
    if (simActive.isLocal) { setConvergence(simActive.localConvergence || []); return }
    supabase.from('convergence_data').select('donnees').eq('simulation_id', simActive.id).single().then(({ data }) => setConvergence(data?.donnees || []))
  }, [simActive?.id])

  useEffect(() => {
    if (!compareMode || !simActiveB) { setConvergenceB([]); return }
    if (simActiveB.isLocal) { setConvergenceB(simActiveB.localConvergence || []); return }
    supabase.from('convergence_data').select('donnees').eq('simulation_id', simActiveB.id).single().then(({ data }) => setConvergenceB(data?.donnees || []))
  }, [compareMode, simActiveB?.id])

  // Suppression sécurisée (REV-43 & REV-46)
  const supprimerSimulationActive = async () => {
    if (!simActive) return
    if (!simActive.isLocal && !user) return

    if (!simActive.isLocal) {
      const saisie = window.prompt(`Confirmation de sécurité : tapez le nom exact « ${simActive.nom} » pour supprimer cette simulation de Supabase :`)
      if (saisie !== simActive.nom) return
      const { error } = await supabase.from('simulations').update({ deleted_at: new Date().toISOString() }).eq('id', simActive.id)
      if (error) { setDeleteMsg(`Erreur Supabase : ${error.message}`); return }
      setDeleteMsg(`Simulation « ${simActive.nom} » supprimée de Supabase.`)
    }

    const idASupprimer = simActive.id
    const restantes = simulations.filter((s) => s.id !== idASupprimer)
    setSimulations(restantes)
    setSelectedSim(restantes[0] || null)
    if (selectedSimB?.id === idASupprimer) setSelectedSimB(restantes.find((s) => s.id !== restantes[0]?.id) || null)
    if (restantes.length < 2) setCompareMode(false)
  }

  const renommerSimLocale = () => {
    if (!simActive?.isLocal || !localNameDraft.trim()) return
    setSimulations((prev) => prev.map((s) => (s.id === simActive.id ? { ...s, nom: localNameDraft.trim() } : s)))
    setRenamingLocal(false)
  }

  const pointsPolaireBruts = useMemo(() => {
    if (!simActive || simActive.profil_type !== 'aile_2d') return []
    const nomProfilCible = simActive.metadonnees?.profil
    if (!nomProfilCible) return []
    return simulationsEnrichies
      .filter((s) => s.profil_type === 'aile_2d' && s.metadonnees?.profil === nomProfilCible && s.metadonnees?.alpha !== undefined)
      .map((s) => {
        const alpha = Number(s.metadonnees.alpha)
        const cl = trouverValeurKpi(s.kpi_finaux, ['cl', 'cl-1', 'lift-coeff', 'portance'])
        const cd = trouverValeurKpi(s.kpi_finaux, ['cd', 'cd-1', 'drag-coeff', 'trainee'])
        const finesse = cl !== null && cd !== null && Math.abs(cd) > 1e-12 ? cl / cd : null
        return { id: s.id, nom: s.nom, alpha, cl, cd, finesse, hasData: cl !== null || cd !== null }
      })
      .sort((a, b) => a.alpha - b.alpha)
  }, [simulationsEnrichies, simActive])

  const pointsPolaireActifs = useMemo(() => pointsPolaireBruts.filter((p) => p.hasData && !excludedPolarIds.includes(p.id)), [pointsPolaireBruts, excludedPolarIds])
  const ptsCl = useMemo(() => pointsPolaireActifs.filter((p) => p.cl !== null), [pointsPolaireActifs])
  const ptsCd = useMemo(() => pointsPolaireActifs.filter((p) => p.cd !== null), [pointsPolaireActifs])
  const ptsFin = useMemo(() => pointsPolaireActifs.filter((p) => p.finesse !== null), [pointsPolaireActifs])
  const ptsLil = useMemo(() => pointsPolaireActifs.filter((p) => p.cl !== null && p.cd !== null), [pointsPolaireActifs])

  const pentePortance = useMemo(() => {
    const zoneLin = ptsCl.filter((p) => Math.abs(p.alpha) <= 10)
    const src = zoneLin.length >= 2 ? zoneLin : ptsCl
    return src.length >= 2 ? regressionLineaire(src.map((p) => p.alpha), src.map((p) => p.cl)) : null
  }, [ptsCl])

  const decrochageDetecte = useMemo(() => {
    for (let i = 1; i < ptsCl.length; i++) {
      if (ptsCl[i].alpha > ptsCl[i - 1].alpha && ptsCl[i].cl < ptsCl[i - 1].cl) return { alphaAvant: ptsCl[i - 1].alpha, alphaApres: ptsCl[i].alpha }
    }
    return null
  }, [ptsCl])

  const decollementDetecte = useMemo(() => {
    const cf = simActive?.profils_paroi?.cf
    if (!cf || !Array.isArray(cf.valeur)) return null
    for (let i = 0; i < cf.valeur.length; i++) {
      if (cf.valeur[i] <= 0) return { x_c: cf.x_c[i], cf: cf.valeur[i] }
    }
    return false
  }, [simActive?.profils_paroi?.cf])

  const pointsInterne = useMemo(() => {
    if (!simActive || simActive.profil_type !== 'interne') return []
    const projetCible = simActive.projet || 'Défaut'
    return simulationsEnrichies
      .filter((s) => s.profil_type === 'interne' && (s.projet || 'Défaut') === projetCible)
      .map((s) => {
        const debitMeta = s.metadonnees?.debit_massique ?? s.metadonnees?.debit
        const debitKpi = trouverValeurKpi(s.kpi_finaux, ['m_in', 'mdot_in', 'debit_entree', 'mass-flow-in'])
        const debit = debitMeta !== undefined ? Number(debitMeta) : debitKpi !== null ? Math.abs(debitKpi) : null
        const dpTot = trouverValeurKpi(s.kpi_finaux, ['δp totale', 'dp totale', 'dp_tot'])
        const dpStat = trouverValeurKpi(s.kpi_finaux, ['δp statique', 'dp statique', 'dp_stat'])
        const kPerte = trouverValeurKpi(s.kpi_finaux, ['coefficient perte k'])
        const re = trouverValeurKpi(s.kpi_finaux, ['reynolds'])
        return { id: s.id, nom: s.nom, debit, dpTot, dpStat, kPerte, re }
      })
      .sort((a, b) => (a.debit ?? 0) - (b.debit ?? 0))
  }, [simulationsEnrichies, simActive])

  const pointsInterneValides = useMemo(() => pointsInterne.filter((p) => p.debit !== null && (p.dpTot !== null || p.dpStat !== null)), [pointsInterne])
  const fitInterne = useMemo(() => {
    if (pointsInterneValides.length < 2) return null
    return ajustementQuadratiqueAvecR2(pointsInterneValides.map((p) => p.debit), pointsInterneValides.map((p) => p.dpTot ?? p.dpStat))
  }, [pointsInterneValides])

  const sauvegarderMapping = () => {
    if (!simActive || !mappingModalTarget || !mappingModalChoice) return
    const next = { ...colMappings, [simActive.id]: { ...(colMappings[simActive.id] || {}), [mappingModalTarget]: mappingModalChoice } }
    setColMappings(next)
    localStorage.setItem('cfd_col_mappings', JSON.stringify(next))
    setMappingModalTarget(null); setMappingModalChoice('')
  }

  const nettoyerMetaDraft = () => {
    const champsAutorises = CHAMPS_EDITION_PAR_PROFIL[simActive?.profil_type] || CHAMPS_EDITION_PAR_PROFIL.generique
    const cleaned = {}
    for (const k of champsAutorises) {
      const v = metaDraft[k]
      if (v === '' || v === null || v === undefined) continue
      const num = Number(v)
      cleaned[k] = !Number.isNaN(num) && String(v).trim() !== '' ? num : v
    }
    return cleaned
  }

  const appliquerMetaLocal = () => {
    if (!simActive) return
    const next = { ...metaOverrides, [simActive.id]: nettoyerMetaDraft() }
    setMetaOverrides(next)
    localStorage.setItem('cfd_meta_overrides', JSON.stringify(next))
    setEditingMeta(false); setSaveStatus('local_only')
  }

  const sauvegarderMetaSupabase = async () => {
    if (!simActive || simActive.isLocal || !user) return
    const cleaned = nettoyerMetaDraft()
    const merged = { ...(simActive.metadonnees || {}), ...cleaned }
    setSaveStatus('saving')
    const { error } = await supabase.from('simulations').update({ metadonnees: merged }).eq('id', simActive.id)
    if (error) {
      setSaveStatus('error')
    } else {
      setSimulations((prev) => prev.map((s) => (s.id === simActive.id ? { ...s, metadonnees: merged } : s)))
      const next = { ...metaOverrides }; delete next[simActive.id]
      setMetaOverrides(next); localStorage.setItem('cfd_meta_overrides', JSON.stringify(next))
      setEditingMeta(false); setSaveStatus('saved')
    }
  }

  const reinitialiserMetaLocal = () => {
    if (!simActive) return
    const next = { ...metaOverrides }; delete next[simActive.id]
    setMetaOverrides(next); localStorage.setItem('cfd_meta_overrides', JSON.stringify(next))
    setEditingMeta(false); setSaveStatus('')
  }

  const importerFichierParoiLocal = async (file, typeCible) => {
    if (!file || !simActive) return
    try {
      const parsed = parserFichierXY(await file.text(), file.name, Number(simActive.metadonnees?.corde || 1))
      setLocalParoiOverrides((prev) => ({ ...prev, [simActive.id]: { ...(prev[simActive.id] || {}), [typeCible]: parsed } }))
    } catch (err) { alert(err.message) }
  }

  const chargerRefCp = async (file) => {
    if (!file) return
    try {
      const parsed = parserFichierXY(await file.text(), file.name, 1)
      setRefCpData({ nom: file.name, x: parsed.x_c, y: parsed.valeur })
    } catch (err) { alert(err.message) }
  }

  const chargerRefPolaire = async (file) => {
    if (!file) return
    try { setRefPolarData(parserPolaireRef(await file.text(), file.name)) } catch (err) { alert(err.message) }
  }

  const activerDesactiverComparaison = () => {
    const next = !compareMode
    setCompareMode(next)
    if (next) setActiveTab('synthese')
    if (next && !selectedSimB && simulations.length > 1) setSelectedSimB(simulations.find((s) => s.id !== selectedSim?.id) || simulations[0])
  }

  const reinitialiserFiltres = () => { setSearchQuery(''); setFilterProfil('tous'); setFilterStatut('tous') }

  const traiterFichiersLocaux = async (fileList) => {
    const files = Array.from(fileList || [])
    if (files.length === 0) return
    setUploadError('')
    try {
      const parsedList = []
      for (const file of files) {
        parsedList.push({ name: file.name, ...parserFichierFluent(await file.text(), file.name) })
      }
      const nMin = Math.min(...parsedList.map((p) => p.donnees.length))
      const donneesFusionnees = []
      for (let i = 0; i < nMin; i++) {
        const row = { ...parsedList[0].donnees[i] }
        for (let fIdx = 1; fIdx < parsedList.length; fIdx++) {
          for (const [k, v] of Object.entries(parsedList[fIdx].donnees[i])) {
            if (!(k in row)) row[k] = v
          }
        }
        donneesFusionnees.push(row)
      }
      const kpiFusionnes = Object.assign({}, ...parsedList.map((p) => p.kpiFinaux))
      const nomsPropres = parsedList.map((p) => p.name.replace(/\.[^/.]+$/, ''))
      const nomSim = nomsPropres.length > 1 ? nomsPropres.join(' + ') : nomsPropres[0]

      const simLocale = {
        id: `local-${Date.now()}`,
        nom: nomSim,
        description: `Analyse temporaire (${files.length} fichier${files.length > 1 ? 's' : ''}, ${nMin} lignes)`,
        profil_type: 'generique',
        profil_version: '1.3',
        statut: 'complete',
        projet: 'Session temporaire',
        tags: ['temporaire'],
        metadonnees: { abscisse: parsedList[0].axeX, ...(parsedList[0].dt ? { dt: Number(parsedList[0].dt.toPrecision(4)) } : {}) },
        validation: { statut: 'OK', messages: [], composants: { courbes: true, parois: false, champs: false, metadonnees: true } },
        kpi_finaux: kpiFusionnes,
        profils_paroi: {},
        url_visuel_3d: null,
        isLocal: true,
        localConvergence: donneesFusionnees,
      }

      setSimulations((prev) => [simLocale, ...prev])
      reinitialiserFiltres()
      setSelectedSim(simLocale)
    } catch (err) {
      setUploadError(err.message || 'Erreur lors de la lecture des fichiers.')
    }
  }

  const attacherImageLocale = (file) => {
    if (!file || !simActive) return
    const imageUrl = URL.createObjectURL(file)
    setSimulations((prev) => prev.map((s) => (s.id === simActive.id ? { ...s, url_visuel_3d: imageUrl } : s)))
  }

  const exporterCSV = (donnees, nom) => {
    if (!donnees || donnees.length === 0) return
    const cles = Object.keys(donnees[0])
    const blob = new Blob([[cles.join(','), ...donnees.map((row) => cles.map((c) => row[c]).join(','))].join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${nom}_courbes.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const gererRelayoutZoom = (ev) => {
    if (ev['xaxis.range[0]'] !== undefined && ev['xaxis.range[1]'] !== undefined) setSyncedRangeX([ev['xaxis.range[0]'], ev['xaxis.range[1]']])
    else if (ev['xaxis.autorange']) setSyncedRangeX(null)
  }

  const isComparing = compareMode && simActive && simActiveB
  const axesA = extraireAxes(convergence, simActive?.metadonnees?.abscisse)
  const axesB = extraireAxes(convergenceB, simActiveB?.metadonnees?.abscisse)
  const groupesA = useMemo(() => grouperVariablesParGrandeur(axesA.variablesY), [axesA.variablesY])

  const tracesA = axesA.variablesY.map((varY, i) => ({
    x: convergence.map((row) => row[axesA.axeX]),
    y: appliquerMoyenneGlissante(convergence.map((row) => row[varY]), smoothingWindow),
    type: 'scatter',
    mode: convergence.length <= 15 ? 'lines+markers' : 'lines',
    name: varY,
    line: { width: 2, color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] },
  }))

  const tracesB = isComparing
    ? axesB.variablesY.map((varY, i) => ({
        x: convergenceB.map((row) => row[axesB.axeX]),
        y: appliquerMoyenneGlissante(convergenceB.map((row) => row[varY]), smoothingWindow),
        type: 'scatter',
        mode: convergenceB.length <= 15 ? 'lines+markers' : 'lines',
        name: varY,
        line: { width: 2, color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] },
      }))
    : []

  const kpiComparatif = isComparing
    ? Array.from(new Set([...Object.keys(simActive.kpi_finaux || {}), ...Object.keys(simActiveB.kpi_finaux || {})])).map((cle) => {
        const kA = simActive.kpi_finaux?.[cle] !== undefined ? normaliserKpi(simActive.kpi_finaux[cle]) : null
        const kB = simActiveB.kpi_finaux?.[cle] !== undefined ? normaliserKpi(simActiveB.kpi_finaux[cle]) : null
        const hasBoth = kA && kB && !Number.isNaN(kA.valeur) && !Number.isNaN(kB.valeur)
        const delta = hasBoth ? kB.valeur - kA.valeur : null
        const pct = hasBoth && Math.abs(kA.valeur) > 1e-12 ? ((kB.valeur - kA.valeur) / Math.abs(kA.valeur)) * 100 : null
        return { cle, kA, kB, delta, pct }
      })
    : []

  const telechargerGraphique = async (ref, nomFichier) => {
    if (!ref.current) return
    await Plotly.downloadImage(ref.current, { format: 'png', width: 1600, height: 800, filename: nomFichier })
  }

  const telechargerImageCFD = async (url, nom) => {
    if (!url) return
    try {
      const blob = await (await fetch(url)).blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = blobUrl; a.download = `${nom}_champ_cfd.png`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(blobUrl)
    } catch { window.open(url, '_blank') }
  }

  const exporterPDF = async () => {
    if (!simActive) return
    setExportingPdf(true)
    try {
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      const pageWidth = doc.internal.pageSize.getWidth()
      const pageHeight = doc.internal.pageSize.getHeight()
      const margin = 15
      const contentWidth = pageWidth - margin * 2

      doc.setFillColor(30, 41, 59)
      doc.rect(0, 0, pageWidth, 34, 'F')
      doc.setTextColor(255, 255, 255)
      doc.setFontSize(16)
      doc.setFont('helvetica', 'bold')
      doc.text(isComparing ? 'Rapport Comparatif CFD — ANSYS Fluent' : 'Rapport de Post-Traitement CFD — ANSYS Fluent', margin, 14)

      doc.setFontSize(10)
      doc.setFont('helvetica', 'normal')
      const dateStr = new Date().toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })
      const mentionLocal = simActive.isLocal ? ' [NON ENREGISTRÉ — TEMPORAIRE]' : ''
      const sousTitre = isComparing
        ? `A : ${simActive.nom}   vs   B : ${simActiveB.nom}   |   ${dateStr}`
        : `Simulation : ${simActive.nom}${mentionLocal} (${PROFIL_LABELS[simActive.profil_type] || 'Générique'})   |   ${dateStr}`
      doc.text(sousTitre, margin, 24)

      let y = 42
      doc.setTextColor(30, 41, 59)

      if (!isComparing) {
        const metaRows = Object.entries(simActive.metadonnees || {}).filter(([k]) => k !== 'frontieres').map(([k, v]) => {
          const cfg = META_CONFIG[k] || { label: k, unite: '' }
          return [cfg.label, `${formaterTexteMeta(k, v)}${cfg.unite ? ' ' + cfg.unite : ''}`]
        })
        if (metaRows.length > 0) {
          doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.text('1. Paramètres & Hypothèses du cas', margin, y); y += 4
          autoTable(doc, { startY: y, head: [['Paramètre', 'Valeur']], body: metaRows, theme: 'grid', styles: { fontSize: 8.5, cellPadding: 2 }, headStyles: { fillColor: [71, 85, 105], textColor: 255 }, margin: { left: margin, right: margin } })
          y = doc.lastAutoTable.finalY + 10
        }
      }

      if (isComparing && kpiComparatif.length > 0) {
        doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.text('1. Comparaison des indicateurs clés (KPI)', margin, y); y += 4
        autoTable(doc, {
          startY: y,
          head: [['KPI', simActive.nom, simActiveB.nom, 'Écart (B - A)', 'Écart (%)']],
          body: kpiComparatif.map((row) => [
            row.cle,
            row.kA ? `${formaterNombre(row.kA.valeur)}${row.kA.unite !== '-' ? ' ' + row.kA.unite : ''}` : '—',
            row.kB ? `${formaterNombre(row.kB.valeur)}${row.kB.unite !== '-' ? ' ' + row.kB.unite : ''}` : '—',
            row.delta !== null ? `${row.delta >= 0 ? '+' : ''}${formaterNombre(row.delta)}` : '—',
            row.pct !== null ? `${row.pct >= 0 ? '+' : ''}${row.pct.toFixed(2)} %` : '—',
          ]),
          theme: 'striped', headStyles: { fillColor: [37, 99, 235], textColor: 255 }, margin: { left: margin, right: margin },
        })
        y = doc.lastAutoTable.finalY + 10
      } else {
        const kpiEntries = Object.entries(simActive.kpi_finaux || {})
        if (kpiEntries.length > 0) {
          if (y + 35 > pageHeight - 15) { doc.addPage(); y = 20 }
          doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.text('2. Indicateurs clés (KPI)', margin, y); y += 4
          autoTable(doc, {
            startY: y,
            head: [['KPI', 'Valeur / RMS', 'Écart-type / Amp.', 'Unité', 'Statut']],
            body: kpiEntries.map(([k, v]) => {
              const kpi = normaliserKpi(v)
              const isOsc = ['periodique', 'oscillant', 'instabilite'].includes(kpi.convergence)
              return [
                k,
                isOsc && kpi.rms !== null ? `RMS ${formaterNombre(kpi.rms)}` : formaterNombre(kpi.valeur),
                isOsc && kpi.amplitude !== null ? `± ${formaterNombre(kpi.amplitude)}` : (kpi.ecart_type !== null ? `± ${formaterNombre(kpi.ecart_type)}` : '—'),
                kpi.unite || '-',
                CONV_STYLES[kpi.convergence]?.label || '—',
              ]
            }),
            didParseCell: (data) => {
              if (data.section === 'body' && data.column.index === 4) {
                const rgb = CONV_STYLES[normaliserKpi(kpiEntries[data.row.index][1]).convergence]?.pdfRgb
                if (rgb) data.cell.styles.fillColor = rgb
              }
            },
            theme: 'striped', styles: { fontSize: 8.5 }, headStyles: { fillColor: [37, 99, 235], textColor: 255 }, margin: { left: margin, right: margin },
          })
          y = doc.lastAutoTable.finalY + 10
        }
      }

      if (isComparing) {
        const halfW = (contentWidth - 6) / 2
        const hImg = halfW * (550 / 800)
        if (y + hImg + 14 > pageHeight - 15) { doc.addPage(); y = 20 }
        doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.text('2. Courbes de convergence (côte à côte)', margin, y); y += 5
        if (activePlotRef.current) doc.addImage(await Plotly.toImage(activePlotRef.current, { format: 'png', width: 800, height: 550 }), 'PNG', margin, y, halfW, hImg)
        if (plotDivRefB.current) doc.addImage(await Plotly.toImage(plotDivRefB.current, { format: 'png', width: 800, height: 550 }), 'PNG', margin + halfW + 6, y, halfW, hImg)
      } else if (activeTab === 'polaires' && Object.values(polarRefs.current).some(Boolean)) {
        const keys = ['cl', 'cd', 'fin', 'lil'].filter((k) => polarRefs.current[k])
        const halfW = (contentWidth - 6) / 2
        const hImg = halfW * (360 / 500)
        if (y + hImg + 14 > pageHeight - 15) { doc.addPage(); y = 20 }
        doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.text('3. Polaires aérodynamiques du projet', margin, y); y += 5
        for (let i = 0; i < keys.length; i++) {
          const colIdx = i % 2
          if (colIdx === 0 && i > 0) y += hImg + 6
          if (y + hImg > pageHeight - 15) { doc.addPage(); y = 20 }
          doc.addImage(await Plotly.toImage(polarRefs.current[keys[i]], { format: 'png', width: 500, height: 360 }), 'PNG', margin + colIdx * (halfW + 6), y, halfW, hImg)
        }
      } else if (activePlotRef.current) {
        const plotHeight = contentWidth * (600 / 1200)
        if (y + plotHeight + 14 > pageHeight - 15) { doc.addPage(); y = 20 }
        doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.text(`3. Graphique principal (onglet : ${activeTab})`, margin, y); y += 5
        doc.addImage(await Plotly.toImage(activePlotRef.current, { format: 'png', width: 1200, height: 600 }), 'PNG', margin, y, contentWidth, plotHeight)
      }

      const totalPages = doc.internal.getNumberOfPages()
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i)
        doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(120, 120, 120)
        doc.text(`CFD Post-Pro • cfdpost.netlify.app${simActive.isLocal ? ' • NON ENREGISTRÉ' : ''}`, margin, pageHeight - 8)
        doc.text(`Page ${i} / ${totalPages}`, pageWidth - margin, pageHeight - 8, { align: 'right' })
      }
      doc.save(isComparing ? `Comparaison_CFD_${simActive.nom}_vs_${simActiveB.nom}.pdf` : `Rapport_CFD_${simActive.nom}.pdf`)
    } finally { setExportingPdf(false) }
  }

  const btnStyle = { padding: '8px 14px', borderRadius: 6, border: 'none', backgroundColor: '#2563eb', color: '#ffffff', fontWeight: 600, cursor: 'pointer' }
  const tabBtnStyle = (actif) => ({ padding: '9px 16px', borderRadius: 8, border: actif ? '1px solid #2563eb' : '1px solid #cbd5e1', backgroundColor: actif ? '#2563eb' : '#ffffff', color: actif ? '#ffffff' : '#1e293b', fontWeight: 600, cursor: 'pointer' })
  const badgeStyle = (bg, color) => ({ display: 'inline-block', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, backgroundColor: bg, color })
  const thStyle = { textAlign: 'left', padding: '10px 12px', borderBottom: '2px solid #cbd5e1', backgroundColor: '#f8fafc' }
  const tdStyle = { padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }

  const statutInfo = STATUT_STYLES[simActive?.statut || 'complete'] || STATUT_STYLES.complete
  const frontieresObj = simActive?.metadonnees?.frontieres && typeof simActive.metadonnees.frontieres === 'object' ? simActive.metadonnees.frontieres : null
  const metaEntries = Object.entries(simActive?.metadonnees || {}).filter(([k]) => k !== 'frontieres')
  const paroi = simActive?.profils_paroi || {}
  const composants = { courbes: convergence.length > 0, parois: Object.keys(paroi).length > 0, champs: Boolean(simActive?.url_visuel_3d), metadonnees: metaEntries.length > 0 }

  const isAile2D = !isComparing && simActive?.profil_type === 'aile_2d'
  const isInterne = !isComparing && simActive?.profil_type === 'interne'

  const kpiManquantsAile2D = isAile2D
    ? [
        { role: 'Cl', nom: 'Cl (Portance)', alias: ['cl', 'cl-1', 'lift-coeff', 'portance'] },
        { role: 'Cd', nom: 'Cd (Traînée)', alias: ['cd', 'cd-1', 'drag-coeff', 'trainee'] },
        { role: 'Cm', nom: 'Cm (Moment)', alias: ['cm', 'cm-1', 'moment-coeff'] },
      ].filter((item) => trouverValeurKpi(simActive.kpi_finaux, item.alias) === null)
    : []

  const repartitionDebits = paroi.repartition_debits || null
  const bilanMasse = paroi.bilan_masse || null
  const pressionCascade = paroi.pression_cascade || null
  const profilsAxiauxInterne = Object.entries(paroi).filter(([k, v]) => !['repartition_debits', 'bilan_masse', 'pression_cascade'].includes(k) && v && Array.isArray(v.x_c))
  const champsEdition = CHAMPS_EDITION_PAR_PROFIL[simActive?.profil_type] || CHAMPS_EDITION_PAR_PROFIL.generique

  return (
    <div className="container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Post-Traitement CFD — ANSYS Fluent</h1>
        {/* Connexion / Déconnexion Supabase Auth (REV-43) */}
        <div>
          {user ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={badgeStyle('#dcfce7', '#166534')}>🔓 {user.email}</span>
              <button onClick={seDeconnecter} style={{ ...btnStyle, backgroundColor: '#475569', fontSize: 12, padding: '6px 10px' }}>Déconnexion</button>
            </div>
          ) : (
            <button onClick={() => setShowAuthModal(true)} style={{ ...btnStyle, backgroundColor: '#1e293b', fontSize: 13 }}>🔐 Connexion admin</button>
          )}
        </div>
      </div>

      {/* Modale de connexion Supabase Auth */}
      {showAuthModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(15, 23, 42, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <form onSubmit={seConnecter} className="card" style={{ width: 360, maxWidth: '90vw', margin: 0 }}>
            <h3 style={{ marginTop: 0 }}>Connexion administrateur</h3>
            <p style={{ fontSize: 12, color: '#64748b' }}>Requise pour modifier ou supprimer les simulations enregistrées dans Supabase.</p>
            <input type="email" required placeholder="Email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} style={{ width: '100%', padding: 8, marginBottom: 8, borderRadius: 6, border: '1px solid #cbd5e1', boxSizing: 'border-box' }} />
            <input type="password" required placeholder="Mot de passe" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} style={{ width: '100%', padding: 8, marginBottom: 10, borderRadius: 6, border: '1px solid #cbd5e1', boxSizing: 'border-box' }} />
            {authError && <p style={{ color: '#dc2626', fontSize: 12, marginTop: 0 }}>{authError}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={() => setShowAuthModal(false)} style={{ ...btnStyle, backgroundColor: '#94a3b8' }}>Annuler</button>
              <button type="submit" style={btnStyle}>Se connecter</button>
            </div>
          </form>
        </div>
      )}

      {/* Zone d'upload manuel multi-fichiers */}
      <div
        className="card"
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); traiterFichiersLocaux(e.dataTransfer.files) }}
        style={{ border: isDragging ? '2px dashed #2563eb' : '2px dashed #cbd5e1', backgroundColor: isDragging ? '#eff6ff' : undefined, textAlign: 'center', padding: 16, transition: 'all 0.2s' }}
      >
        <p style={{ margin: '0 0 8px 0', fontWeight: 600 }}>
          📂 Post-traitement rapide (analyse locale temporaire) : glissez-déposez un ou plusieurs fichiers Fluent (.out, .csv, .txt, .xy)
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
          <label style={btnStyle}>
            Choisir un ou plusieurs fichiers
            <input type="file" multiple accept=".out,.csv,.txt,.xy" style={{ display: 'none' }} onChange={(e) => { traiterFichiersLocaux(e.target.files); e.target.value = '' }} />
          </label>
          {simActive?.isLocal && (
            <label style={{ ...btnStyle, backgroundColor: '#475569' }}>
              🖼️ Ajouter une image CFD (.png/.jpg)
              <input type="file" accept="image/png,image/jpeg" style={{ display: 'none' }} onChange={(e) => { attacherImageLocale(e.target.files?.[0]); e.target.value = '' }} />
            </label>
          )}
        </div>
        {uploadError && <p style={{ color: '#dc2626', marginTop: 10, marginBottom: 0, fontWeight: 600 }}>⚠️ {uploadError}</p>}
      </div>

      {/* Recherche, Filtres & Sélection */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="text" placeholder="🔍 Rechercher par nom, projet ou tag..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} style={{ flex: '1 1 220px', padding: '8px 12px', borderRadius: 6, border: '1px solid #cbd5e1' }} />
          <select value={filterProfil} onChange={(e) => setFilterProfil(e.target.value)} style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1' }}>
            <option value="tous">Tous les profils</option>
            <option value="generique">Générique</option>
            <option value="aile_2d">Aile 2D</option>
            <option value="interne">Écoulement interne</option>
          </select>
          <select value={filterStatut} onChange={(e) => setFilterStatut(e.target.value)} style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1' }}>
            <option value="tous">Tous les statuts</option>
            <option value="complete">Complète</option>
            <option value="partielle">Partielle</option>
            <option value="erreur">Erreur</option>
          </select>
          <span style={{ fontSize: 13, color: '#64748b' }}>{simulationsFiltrees.length} {simulationsFiltrees.length > 1 ? 'simulations' : 'simulation'}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <label style={{ marginRight: 8, fontWeight: 600 }}>{compareMode ? 'Simulation A :' : 'Simulation :'}</label>
              <select value={simActive?.id || ''} onChange={(e) => setSelectedSim(simulations.find((s) => s.id === e.target.value))} disabled={simulationsFiltrees.length === 0}>
                {simulationsFiltrees.length === 0 ? <option value="">Aucune simulation</option> : simulationsFiltrees.map((sim) => (
                  <option key={sim.id} value={sim.id}>{sim.isLocal ? '[Temporaire] ' : ''}{sim.nom} [{PROFIL_LABELS[sim.profil_type] || 'Générique'}]</option>
                ))}
              </select>
            </div>

            {compareMode && (
              <div>
                <label style={{ marginRight: 8, fontWeight: 600 }}>Simulation B :</label>
                <select value={simActiveB?.id || ''} onChange={(e) => setSelectedSimB(simulations.find((s) => s.id === e.target.value))}>
                  {simulationsEnrichies.map((sim) => <option key={sim.id} value={sim.id}>{sim.nom} [{PROFIL_LABELS[sim.profil_type] || 'Générique'}]</option>)}
                </select>
              </div>
            )}

            {simulations.length > 1 && simActive && (
              <button onClick={activerDesactiverComparaison} style={{ ...btnStyle, backgroundColor: compareMode ? '#7c3aed' : '#475569' }}>
                {compareMode ? '✕ Quitter la comparaison' : '⚖️ Comparer 2 simulations'}
              </button>
            )}
          </div>

          {simActive && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {/* REV-43 & REV-46 : Supprimer visible seulement pour un import temporaire ou un admin connecté */}
              {simActive.isLocal && (
                <button onClick={supprimerSimulationActive} style={{ ...btnStyle, backgroundColor: '#64748b' }}>
                  ✕ Retirer de la session
                </button>
              )}
              {!simActive.isLocal && user && (
                <button onClick={supprimerSimulationActive} style={{ ...btnStyle, backgroundColor: '#dc2626' }}>
                  🗑️ Supprimer (base)
                </button>
              )}
              <button onClick={exporterPDF} disabled={exportingPdf} style={{ ...btnStyle, backgroundColor: exportingPdf ? '#64748b' : '#0f766e' }}>
                {exportingPdf ? 'Génération du PDF...' : '📄 Exporter le rapport PDF'}
              </button>
            </div>
          )}
        </div>

        {deleteMsg && <div style={{ fontSize: 13, color: '#92400e', backgroundColor: '#fffbeb', border: '1px solid #fcd34d', padding: '8px 12px', borderRadius: 6 }}>ℹ️ {deleteMsg}</div>}
      </div>

      {loadingSims && <div className="card">Chargement des simulations...</div>}

      {!loadingSims && !simActive && (
        <div className="card" style={{ textAlign: 'center', padding: 28, color: '#475569' }}>
          <p style={{ margin: '0 0 12px 0', fontSize: 15 }}>Aucune simulation ne correspond aux filtres sélectionnés.</p>
          <button onClick={reinitialiserFiltres} style={btnStyle}>Réinitialiser les filtres</button>
        </div>
      )}

      {!loadingSims && simActive && (
        <>
          {!isComparing && (
            <div className="card" style={{ padding: '14px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <span style={badgeStyle('#e0e7ff', '#3730a3')}>Profil : {PROFIL_LABELS[simActive.profil_type] || 'Générique'} v{simActive.profil_version || '1.0'}</span>
                  {simActive.isLocal ? (
                    <span style={badgeStyle('#fef3c7', '#92400e')}>⏳ Temporaire (non enregistré)</span>
                  ) : (
                    <span style={badgeStyle(statutInfo.bg, statutInfo.color)}>Statut : {statutInfo.label}</span>
                  )}
                  {simActive.projet && <span style={badgeStyle('#f1f5f9', '#334155')}>📁 {simActive.projet}</span>}
                  {(simActive.tags || []).map((tag) => <span key={tag} style={badgeStyle('#f8fafc', '#475569')}>#{tag}</span>)}
                  {simActive.hasLocalMeta && <span style={badgeStyle('#fef3c7', '#92400e')}>Modifié (local) ⚠️</span>}
                  {saveStatus === 'saved' && <span style={badgeStyle('#dcfce7', '#166534')}>Sauvegardé ✅</span>}
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {simActive.isLocal && !renamingLocal && (
                    <button onClick={() => { setLocalNameDraft(simActive.nom); setRenamingLocal(true) }} style={{ ...btnStyle, backgroundColor: '#f1f5f9', color: '#1e293b', fontSize: 12, padding: '6px 10px' }}>
                      ✏️ Renommer
                    </button>
                  )}
                  <button onClick={() => { setShowMeta((v) => !v); setEditingMeta(false) }} style={{ ...btnStyle, backgroundColor: '#f1f5f9', color: '#1e293b', fontSize: 13, padding: '6px 12px' }}>
                    {showMeta ? '▲ Masquer les hypothèses' : `▼ Hypothèses & Métadonnées (${metaEntries.length})`}
                  </button>
                </div>
              </div>

              {renamingLocal && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                  <input type="text" value={localNameDraft} onChange={(e) => setLocalNameDraft(e.target.value)} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', flex: '0 1 280px' }} />
                  <button onClick={renommerSimLocale} style={{ ...btnStyle, padding: '6px 12px', fontSize: 12 }}>Valider</button>
                  <button onClick={() => setRenamingLocal(false)} style={{ ...btnStyle, backgroundColor: '#94a3b8', padding: '6px 12px', fontSize: 12 }}>Annuler</button>
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10, fontSize: 12 }}>
                <span style={badgeStyle(composants.courbes ? '#dcfce7' : '#f1f5f9', composants.courbes ? '#166534' : '#64748b')}>{composants.courbes ? '✓' : '○'} Courbes</span>
                <button onClick={() => setInfoBadgeMsg(composants.parois ? '' : 'Aucune donnée pariétale ou bilan multi-sorties.')} style={{ ...badgeStyle(composants.parois ? '#dcfce7' : '#f1f5f9', composants.parois ? '#166534' : '#64748b'), border: 'none', cursor: 'pointer' }}>{composants.parois ? '✓' : '○'} Parois / Bilans</button>
                <button onClick={() => setInfoBadgeMsg(composants.champs ? '' : 'Aucun fichier de champ (.case, .vtu) fourni lors de l’ingestion.')} style={{ ...badgeStyle(composants.champs ? '#dcfce7' : '#f1f5f9', composants.champs ? '#166534' : '#64748b'), border: 'none', cursor: 'pointer' }}>{composants.champs ? '✓' : '○'} Champs (.case)</button>
                <span style={badgeStyle(composants.metadonnees ? '#dcfce7' : '#f1f5f9', composants.metadonnees ? '#166534' : '#64748b')}>{composants.metadonnees ? '✓' : '○'} Métadonnées</span>
              </div>

              {infoBadgeMsg && <div style={{ marginTop: 8, fontSize: 12, color: '#475569', backgroundColor: '#f8fafc', padding: '6px 10px', borderRadius: 6 }}>ℹ️ {infoBadgeMsg}</div>}

              {showMeta && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #e2e8f0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                    <strong style={{ fontSize: 13, color: '#334155' }}>Paramètres & Hypothèses ({PROFIL_LABELS[simActive.profil_type]})</strong>
                    {!editingMeta ? (
                      <div style={{ display: 'flex', gap: 6 }}>
                        {simActive.hasLocalMeta && <button onClick={reinitialiserMetaLocal} style={{ ...btnStyle, backgroundColor: '#dc2626', fontSize: 12, padding: '5px 10px' }}>↺ Réinitialiser</button>}
                        {(simActive.isLocal || user) && (
                          <button onClick={() => { setMetaDraft({ ...(simActive.metadonnees || {}) }); setEditingMeta(true) }} style={{ ...btnStyle, backgroundColor: '#475569', fontSize: 12, padding: '5px 10px' }}>
                            ✏️ Éditer
                          </button>
                        )}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button onClick={appliquerMetaLocal} style={{ ...btnStyle, backgroundColor: '#475569', fontSize: 12, padding: '5px 10px' }}>✓ Appliquer (session)</button>
                        {!simActive.isLocal && user && (
                          <button onClick={sauvegarderMetaSupabase} style={{ ...btnStyle, backgroundColor: '#0f766e', fontSize: 12, padding: '5px 10px' }}>
                            {saveStatus === 'saving' ? 'Sauvegarde...' : '💾 Sauvegarder (Supabase)'}
                          </button>
                        )}
                        <button onClick={() => setEditingMeta(false)} style={{ ...btnStyle, backgroundColor: '#94a3b8', fontSize: 12, padding: '5px 10px' }}>Annuler</button>
                      </div>
                    )}
                  </div>

                  {editingMeta ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 8 }}>
                      {champsEdition.map((k) => {
                        const cfg = META_CONFIG[k] || { label: k, unite: '' }
                        return (
                          <label key={k} style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 3 }}>
                            <span>{cfg.label} {cfg.unite ? `(${cfg.unite})` : ''}</span>
                            <input type="text" value={metaDraft[k] ?? ''} onChange={(e) => setMetaDraft((prev) => ({ ...prev, [k]: e.target.value }))} style={{ padding: '5px 8px', borderRadius: 4, border: '1px solid #cbd5e1' }} />
                          </label>
                        )
                      })}
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {metaEntries.map(([k, v]) => {
                          const cfg = META_CONFIG[k] || { label: k, unite: '' }
                          return (
                            <div key={k} style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: '4px 10px', fontSize: 13 }}>
                              <span style={{ color: '#64748b' }}>{cfg.label} : </span>
                              <strong>{formaterTexteMeta(k, v)}{cfg.unite ? ` ${cfg.unite}` : ''}</strong>
                            </div>
                          )
                        })}
                      </div>
                      {frontieresObj && Object.keys(frontieresObj).length > 0 && (
                        <div style={{ marginTop: 10 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginRight: 8 }}>Frontières :</span>
                          {Object.entries(frontieresObj).map(([nom, role]) => (
                            <span key={nom} style={{ ...badgeStyle('#f8fafc', '#334155'), border: '1px solid #cbd5e1', marginRight: 6 }}>
                              <strong>{nom}</strong> → {ROLE_LABELS[String(role).toLowerCase()] || role}
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {simActive.validation?.messages?.length > 0 && (
                <details style={{ marginTop: 10, padding: '8px 12px', borderRadius: 6, backgroundColor: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e', fontSize: 13 }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>⚠️ Synthèse qualité : {simActive.validation.messages.length} avertissement{simActive.validation.messages.length > 1 ? 's' : ''}, 0 erreur (cliquer pour détailler)</summary>
                  <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>{simActive.validation.messages.map((msg, idx) => <li key={idx}>{msg}</li>)}</ul>
                </details>
              )}
            </div>
          )}

          {isAile2D && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              <button onClick={() => setActiveTab('synthese')} style={tabBtnStyle(activeTab === 'synthese')}>📊 Synthèse & Convergence</button>
              <button onClick={() => setActiveTab('paroi')} style={tabBtnStyle(activeTab === 'paroi')}>📈 Répartitions pariétales (Cp, Cf, y+)</button>
              <button onClick={() => setActiveTab('polaires')} style={tabBtnStyle(activeTab === 'polaires')}>✈️ Polaires du projet ({ptsCl.length} cas)</button>
            </div>
          )}

          {isInterne && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              <button onClick={() => setActiveTab('synthese')} style={tabBtnStyle(activeTab === 'synthese')}>📊 Synthèse & Convergence</button>
              <button onClick={() => setActiveTab('interne_bilans')} style={tabBtnStyle(activeTab === 'interne_bilans')}>🔧 Bilans, Débits & Pertes</button>
              <button onClick={() => setActiveTab('interne_carac')} style={tabBtnStyle(activeTab === 'interne_carac')}>📈 Courbe ΔP(Q) du projet ({pointsInterneValides.length} cas)</button>
            </div>
          )}

          {/* ONGLET SYNTHÈSE & CONVERGENCE */}
          {activeTab === 'synthese' && (
            <>
              <div className="card">
                <h2>{isComparing ? 'Comparaison des KPI (Fin de calcul)' : 'KPI Moyennés & Calculés'}</h2>
                {isComparing ? (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={thStyle}>Grandeur (KPI)</th>
                          <th style={thStyle}>{simActive.nom} (A)</th>
                          <th style={thStyle}>{simActiveB.nom} (B)</th>
                          <th style={thStyle}>Écart (B - A)</th>
                          <th style={thStyle}>Écart (%)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {kpiComparatif.map((row) => (
                          <tr key={row.cle}>
                            <td style={{ ...tdStyle, fontWeight: 600 }}>{row.cle}</td>
                            <td style={tdStyle}>{row.kA ? `${formaterNombre(row.kA.valeur)}${row.kA.unite !== '-' ? ' ' + row.kA.unite : ''}` : '—'}</td>
                            <td style={tdStyle}>{row.kB ? `${formaterNombre(row.kB.valeur)}${row.kB.unite !== '-' ? ' ' + row.kB.unite : ''}` : '—'}</td>
                            <td style={tdStyle}>{row.delta !== null ? `${row.delta >= 0 ? '+' : ''}${formaterNombre(row.delta)}` : '—'}</td>
                            <td style={{ ...tdStyle, fontWeight: 600, color: row.pct === null ? '#64748b' : row.pct >= 0 ? '#0f766e' : '#dc2626' }}>
                              {row.pct !== null ? `${row.pct >= 0 ? '+' : ''}${row.pct.toFixed(2)} %` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="kpi-grid">
                    {Object.entries(simActive.kpi_finaux || {}).map(([k, rawVal]) => {
                      const kpi = normaliserKpi(rawVal)
                      const conv = CONV_STYLES[kpi.convergence]
                      const isOsc = ['periodique', 'oscillant', 'instabilite'].includes(kpi.convergence)
                      return (
                        <div key={k} className="kpi-box" title={`Valeur exacte : ${kpi.valeur} | Fenêtre : ${kpi.fenetre} pts | Source : ${kpi.source}`}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                            <div className="kpi-label">{k}</div>
                            {conv && (
                              <span style={badgeStyle(conv.bg, conv.color)}>
                                {kpi.convergence === 'indetermine' && kpi.fenetre > 0 ? `Indéterminé (n=${kpi.fenetre})` : conv.label}
                              </span>
                            )}
                          </div>

                          {isOsc && kpi.rms !== null ? (
                            <>
                              <div className="kpi-value" style={{ fontSize: 20 }}>RMS {formaterNombre(kpi.rms)}</div>
                              <div style={{ fontSize: 12, color: '#334155', marginTop: 2 }}>Amplitude : ±{formaterNombre(kpi.amplitude)}</div>
                              <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                                {kpi.moyenne_significative ? `Moy. (périodes entières) : ${formaterNombre(kpi.valeur)}` : 'Moyenne non significative'}
                                {kpi.frequence_hz ? ` • f = ${formaterNombre(kpi.frequence_hz)} Hz` : ''}
                                {kpi.strouhal ? ` • St = ${formaterNombre(kpi.strouhal)}` : ''}
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="kpi-value">
                                {formaterNombre(kpi.valeur)}
                                {kpi.unite && kpi.unite !== '-' && <span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>{kpi.unite}</span>}
                              </div>
                              {kpi.variation_rel_pct !== null && kpi.variation_rel_pct !== undefined ? (
                                <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                                  Dérive : {formaterNombre(kpi.variation_rel_pct)} % ({kpi.fenetre} pts)
                                </div>
                              ) : kpi.ecart_type !== null ? (
                                <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>σ = ±{formaterNombre(kpi.ecart_type)} ({kpi.fenetre} pts)</div>
                              ) : (
                                <div style={{ fontSize: 12, color: kpi.hypothese ? '#b45309' : '#64748b', marginTop: 4 }}>{kpi.methode}</div>
                              )}
                            </>
                          )}
                        </div>
                      )
                    })}

                    {kpiManquantsAile2D.map((item) => (
                      <div key={item.role} className="kpi-box" style={{ borderStyle: 'dashed', backgroundColor: '#f8fafc', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                        <div>
                          <div className="kpi-label">{item.nom}</div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: '#94a3b8', marginTop: 6 }}>Donnée manquante</div>
                        </div>
                        <button onClick={() => { setMappingModalTarget(item.role); setMappingModalChoice(axesA.variablesY[0] || '') }} style={{ ...btnStyle, backgroundColor: '#475569', fontSize: 12, padding: '5px 10px', marginTop: 8 }}>
                          ⚙️ Associer une colonne
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {mappingModalTarget && (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(15, 23, 42, 0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
                  <div className="card" style={{ width: 380, maxWidth: '90vw', margin: 0 }}>
                    <h3 style={{ marginTop: 0 }}>Associer une colonne à « {mappingModalTarget} »</h3>
                    <select value={mappingModalChoice} onChange={(e) => setMappingModalChoice(e.target.value)} style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1', marginBottom: 14 }}>
                      {axesA.variablesY.map((col) => <option key={col} value={col}>{col}</option>)}
                    </select>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <button onClick={() => setMappingModalTarget(null)} style={{ ...btnStyle, backgroundColor: '#94a3b8' }}>Annuler</button>
                      <button onClick={sauvegarderMapping} style={btnStyle}>Enregistrer</button>
                    </div>
                  </div>
                </div>
              )}

              {/* COURBES DE CONVERGENCE (Modif #1 : bouton Côte à côte + REV-47 : Double axe Y couleurs cohérentes) */}
              {(tracesA.length > 0 || tracesB.length > 0) && (
                <div className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
                    <h2 style={{ margin: 0 }}>{isComparing ? 'Courbes de convergence côte à côte' : 'Courbes de convergence'}</h2>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {!isComparing && axesA.variablesY.length > 1 && (
                        <>
                          <button
                            onClick={() => { setSplitPlots((v) => !v); setDualYAxis(false) }}
                            style={{ ...btnStyle, backgroundColor: splitPlots ? '#2563eb' : '#e2e8f0', color: splitPlots ? '#fff' : '#1e293b' }}
                          >
                            📊 {splitPlots ? 'Côte à côte : Actif' : 'Côte à côte'}
                          </button>
                          <button
                            onClick={() => { setDualYAxis((v) => !v); setSplitPlots(false) }}
                            style={{ ...btnStyle, backgroundColor: dualYAxis ? '#7c3aed' : '#e2e8f0', color: dualYAxis ? '#fff' : '#1e293b' }}
                          >
                            ⇄ {dualYAxis ? 'Double axe Y : Actif' : 'Double axe Y'}
                          </button>
                        </>
                      )}

                      <select value={smoothingWindow} onChange={(e) => setSmoothingWindow(Number(e.target.value))} style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13 }}>
                        <option value={0}>Lissage : Aucun</option>
                        <option value={5}>Moy. glissante (5 pts)</option>
                        <option value={10}>Moy. glissante (10 pts)</option>
                        <option value={20}>Moy. glissante (20 pts)</option>
                      </select>

                      <button onClick={() => setYScale((prev) => (prev === 'linear' ? 'log' : 'linear'))} style={{ ...btnStyle, backgroundColor: yScale === 'log' ? '#0f766e' : '#e2e8f0', color: yScale === 'log' ? '#fff' : '#1e293b' }}>
                        {yScale === 'log' ? 'Échelle Y : Log' : 'Échelle Y : Linéaire'}
                      </button>

                      {!isComparing && (
                        <>
                          <button onClick={() => exporterCSV(convergence, simActive.nom)} style={{ ...btnStyle, backgroundColor: '#475569' }}>⬇ CSV</button>
                          <button onClick={() => telechargerGraphique(activePlotRef, `${simActive.nom}_convergence`)} style={btnStyle}>⬇ PNG</button>
                        </>
                      )}
                    </div>
                  </div>

                  {isComparing ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
                      <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <strong>A — {simActive.nom}</strong>
                          <button onClick={() => telechargerGraphique(activePlotRef, `${simActive.nom}_convergence`)} style={{ ...btnStyle, padding: '5px 10px', fontSize: 12 }}>⬇ PNG</button>
                        </div>
                        <Plot data={tracesA} layout={creerLayoutPlotly(simActive.nom, axesA.labelX, 'Valeur', 400, yScale, axesA.isIntegerX, axesA.nbPoints, syncedRangeX)} style={{ width: '100%' }} useResizeHandler onRelayout={gererRelayoutZoom} onInitialized={(_, g) => { activePlotRef.current = g }} onUpdate={(_, g) => { activePlotRef.current = g }} />
                      </div>
                      <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <strong>B — {simActiveB.nom}</strong>
                          <button onClick={() => telechargerGraphique(plotDivRefB, `${simActiveB.nom}_convergence`)} style={{ ...btnStyle, padding: '5px 10px', fontSize: 12 }}>⬇ PNG</button>
                        </div>
                        <Plot data={tracesB} layout={creerLayoutPlotly(simActiveB.nom, axesB.labelX, 'Valeur', 400, yScale, axesB.isIntegerX, axesB.nbPoints, syncedRangeX)} style={{ width: '100%' }} useResizeHandler onRelayout={gererRelayoutZoom} onInitialized={(_, g) => { plotDivRefB.current = g }} onUpdate={(_, g) => { plotDivRefB.current = g }} />
                      </div>
                    </div>
                  ) : splitPlots ? (
                    /* Modif #1 : Chaque courbe dans son propre graphe côte à côte (zoom X synchronisé) */
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
                      {axesA.variablesY.map((varY, idx) => {
                        const grp = deduireGroupeGrandeur(varY)
                        const color = PLOTLY_COLORS[idx % PLOTLY_COLORS.length]
                        return (
                          <div key={varY} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 8 }}>
                            <Plot
                              data={[{
                                x: convergence.map((row) => row[axesA.axeX]),
                                y: appliquerMoyenneGlissante(convergence.map((row) => row[varY]), smoothingWindow),
                                type: 'scatter',
                                mode: convergence.length <= 15 ? 'lines+markers' : 'lines',
                                name: varY,
                                line: { width: 2, color },
                              }]}
                              layout={creerLayoutPlotly(`${varY} — ${simActive.nom}`, axesA.labelX, grp.unite, 370, yScale, axesA.isIntegerX, axesA.nbPoints, syncedRangeX)}
                              style={{ width: '100%' }}
                              useResizeHandler
                              onRelayout={gererRelayoutZoom}
                              onInitialized={(_, g) => { if (idx === 0) activePlotRef.current = g }}
                              onUpdate={(_, g) => { if (idx === 0) activePlotRef.current = g }}
                            />
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                      {groupesA.map((grp, idx) => {
                        const useDual = dualYAxis && grp.vars.length > 1
                        const leftVars = useDual ? [grp.vars[0]] : grp.vars
                        const rightVars = useDual ? grp.vars.slice(1) : []
                        return (
                          <Plot
                            key={grp.id}
                            data={grp.vars.map((varY, vIdx) => {
                              const isRight = useDual && vIdx > 0
                              const color = PLOTLY_COLORS[vIdx % PLOTLY_COLORS.length]
                              return {
                                x: convergence.map((row) => row[axesA.axeX]),
                                y: appliquerMoyenneGlissante(convergence.map((row) => row[varY]), smoothingWindow),
                                type: 'scatter',
                                mode: convergence.length <= 15 ? 'lines+markers' : 'lines',
                                name: `${varY}${isRight ? ' (axe droit)' : ''}`,
                                yaxis: isRight ? 'y2' : 'y',
                                line: { width: 2, color },
                              }
                            })}
                            layout={creerLayoutPlotly(
                              `${grp.titre} — ${simActive.nom}`, axesA.labelX, grp.unite, 390, yScale,
                              axesA.isIntegerX, axesA.nbPoints, syncedRangeX, useDual,
                              PLOTLY_COLORS[0], PLOTLY_COLORS[1],
                              leftVars.join(', '), rightVars.join(', ')
                            )}
                            style={{ width: '100%' }}
                            useResizeHandler
                            onRelayout={gererRelayoutZoom}
                            onInitialized={(_, g) => { if (idx === 0) activePlotRef.current = g }}
                            onUpdate={(_, g) => { if (idx === 0) activePlotRef.current = g }}
                          />
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Champs CFD */}
              {isComparing ? (
                (simActive.url_visuel_3d || simActiveB.url_visuel_3d) && (
                  <div className="card">
                    <h2>Visualisation comparée des champs CFD</h2>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
                      {simActive.url_visuel_3d && <div><strong>{simActive.nom} (A)</strong><img src={simActive.url_visuel_3d} alt={simActive.nom} style={{ width: '100%', borderRadius: 8, marginTop: 6 }} /></div>}
                      {simActiveB.url_visuel_3d && <div><strong>{simActiveB.nom} (B)</strong><img src={simActiveB.url_visuel_3d} alt={simActiveB.nom} style={{ width: '100%', borderRadius: 8, marginTop: 6 }} /></div>}
                    </div>
                  </div>
                )
              ) : (
                simActive.url_visuel_3d && (
                  <div className="card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <h2 style={{ margin: 0 }}>Visualisation du champ CFD</h2>
                      <button onClick={() => telechargerImageCFD(simActive.url_visuel_3d, simActive.nom)} style={btnStyle}>⬇ Télécharger (PNG)</button>
                    </div>
                    <img src={simActive.url_visuel_3d} alt={simActive.nom} style={{ width: '100%', borderRadius: 8 }} />
                  </div>
                )
              )}
            </>
          )}

          {/* ONGLET RÉPARTITIONS PARIÉTALES (Ligne Cf=0 + zone décollement rouge) */}
          {isAile2D && activeTab === 'paroi' && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <h2 style={{ margin: 0 }}>Répartitions pariétales — {simActive.nom}</h2>
                  {decollementDetecte && <span style={badgeStyle('#fee2e2', '#991b1b')}>⚠️ Décollement détecté à x/c = {formaterNombre(decollementDetecte.x_c)}</span>}
                  {decollementDetecte === false && <span style={badgeStyle('#dcfce7', '#166534')}>✓ Aucun décollement détecté (Cf &gt; 0)</span>}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <label style={{ ...btnStyle, fontSize: 13 }}>📂 Importer Cp<input type="file" accept=".xy,.csv,.txt,.dat" style={{ display: 'none' }} onChange={(e) => { importerFichierParoiLocal(e.target.files?.[0], 'cp'); e.target.value = '' }} /></label>
                  <label style={{ ...btnStyle, backgroundColor: '#0f766e', fontSize: 13 }}>📂 Importer Cf<input type="file" accept=".xy,.csv,.txt,.dat" style={{ display: 'none' }} onChange={(e) => { importerFichierParoiLocal(e.target.files?.[0], 'cf'); e.target.value = '' }} /></label>
                  <label style={{ ...btnStyle, backgroundColor: '#7c3aed', fontSize: 13 }}>📂 Importer y+<input type="file" accept=".xy,.csv,.txt,.dat" style={{ display: 'none' }} onChange={(e) => { importerFichierParoiLocal(e.target.files?.[0], 'yplus'); e.target.value = '' }} /></label>
                  <label style={{ ...btnStyle, backgroundColor: '#475569', fontSize: 13 }}>📌 Réf. Cp (XFOIL / CSV)<input type="file" accept=".csv,.txt,.xy,.dat" style={{ display: 'none' }} onChange={(e) => { chargerRefCp(e.target.files?.[0]); e.target.value = '' }} /></label>
                </div>
              </div>

              <button onClick={() => setShowGuideFluent((v) => !v)} style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', padding: 0, fontSize: 13, marginBottom: 12 }}>
                {showGuideFluent ? '▼ Masquer le guide d’export Fluent' : '❓ Comment exporter cp.xy, cf.xy, yplus.xy depuis ANSYS Fluent ?'}
              </button>
              {showGuideFluent && (
                <div style={{ padding: 12, backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, marginBottom: 14 }}>
                  Dans <strong>ANSYS Fluent</strong> : <em>Results → Plots → XY Plot → New</em>. Sélectionnez la paroi, choisissez <strong>Pressure Coefficient</strong> / <em>Skin Friction Coefficient</em> / <em>Wall Yplus</em>, cochez <strong>Write to File</strong>, puis enregistrez sous <code>cp.xy</code>, <code>cf.xy</code> ou <code>yplus.xy</code>.
                </div>
              )}

              {!paroi.cp && !paroi.cf && !paroi.yplus && !refCpData ? (
                <div style={{ padding: 16, backgroundColor: '#f8fafc', borderRadius: 8, color: '#475569' }}>Aucune donnée pariétale chargée.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  {(paroi.cp || refCpData) && (
                    <Plot
                      data={[
                        ...(paroi.cp ? [{ x: paroi.cp.x_c, y: paroi.cp.valeur, type: 'scatter', mode: 'lines', name: `CFD — ${simActive.nom}`, line: { width: 2 } }] : []),
                        ...(refCpData ? [{ x: refCpData.x, y: refCpData.y, type: 'scatter', mode: 'markers', name: `Exp/XFOIL — ${refCpData.nom}`, marker: { size: 6, symbol: 'circle-open', color: '#dc2626' } }] : []),
                      ]}
                      layout={{ autosize: true, height: 440, title: { text: 'Coefficient de pression Cp(x/c) — Axe inversé', font: { size: 15 } }, xaxis: { title: { text: 'x / c' }, showgrid: true, gridcolor: '#e2e8f0' }, yaxis: { title: { text: 'Cp' }, autorange: 'reversed', showgrid: true, gridcolor: '#e2e8f0' }, showlegend: true, legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.22 }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff', margin: { b: 85 } }}
                      style={{ width: '100%' }}
                      useResizeHandler
                      onInitialized={(_, g) => { activePlotRef.current = g }}
                      onUpdate={(_, g) => { activePlotRef.current = g }}
                    />
                  )}
                  {paroi.cf && (
                    <Plot
                      data={[{ x: paroi.cf.x_c, y: paroi.cf.valeur, type: 'scatter', mode: 'lines', name: `Cf — ${simActive.nom}`, line: { width: 2, color: '#2563eb' } }]}
                      layout={{
                        autosize: true, height: 360, title: { text: 'Coefficient de frottement pariétal Cf(x/c)', font: { size: 15 } },
                        xaxis: { title: { text: 'x / c' }, showgrid: true, gridcolor: '#e2e8f0' },
                        yaxis: { title: { text: 'Cf' }, showgrid: true, gridcolor: '#e2e8f0' },
                        shapes: [
                          { type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 0, y1: 0, line: { color: '#dc2626', width: 1.5, dash: 'dash' } },
                          ...(Math.min(...paroi.cf.valeur) < 0 ? [{ type: 'rect', xref: 'paper', x0: 0, x1: 1, y0: Math.min(...paroi.cf.valeur) * 1.1, y1: 0, fillcolor: 'rgba(220,38,38,0.08)', line: { width: 0 } }] : []),
                        ],
                        paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
                      }}
                      style={{ width: '100%' }}
                      useResizeHandler
                    />
                  )}
                  {paroi.yplus && (
                    <Plot
                      data={[{ x: paroi.yplus.x_c, y: paroi.yplus.valeur, type: 'scatter', mode: 'lines', name: `y+ — ${simActive.nom}` }]}
                      layout={{ autosize: true, height: 360, title: { text: 'Distribution pariétale y+(x/c)', font: { size: 15 } }, xaxis: { title: { text: 'x / c' }, showgrid: true, gridcolor: '#e2e8f0' }, yaxis: { title: { text: 'y+' }, showgrid: true, gridcolor: '#e2e8f0' }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff' }}
                      style={{ width: '100%' }}
                      useResizeHandler
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {/* ONGLET POLAIRES DU PROJET (REV-48 : légende corrigée + lignes sans Cl/Cd grisées) */}
          {isAile2D && activeTab === 'polaires' && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <h2 style={{ margin: 0 }}>Polaires du projet — {simActive.metadonnees?.profil || 'Profil 2D'}</h2>
                  {pentePortance && <span style={badgeStyle('#dcfce7', '#166534')}>Pente dCl/dα = {formaterNombre(pentePortance.pente)} /° ({formaterNombre((pentePortance.pente * 180) / Math.PI)} /rad)</span>}
                  {decrochageDetecte && <span style={badgeStyle('#fee2e2', '#991b1b')}>⚠️ Décrochage probable entre α = {decrochageDetecte.alphaAvant}° et {decrochageDetecte.alphaApres}°</span>}
                </div>
                <label style={{ ...btnStyle, backgroundColor: '#475569', fontSize: 13 }}>
                  📌 Polaire de réf. (UIUC / CSV)
                  <input type="file" accept=".csv,.txt,.dat" style={{ display: 'none' }} onChange={(e) => { chargerRefPolaire(e.target.files?.[0]); e.target.value = '' }} />
                </label>
              </div>

              {ptsCl.length < 1 && ptsCd.length < 1 ? (
                <div style={{ padding: 16, marginTop: 12, backgroundColor: '#f8fafc', borderRadius: 8, color: '#475569' }}>Cochez au moins 1 simulation contenant Cl et/ou Cd.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 16, marginTop: 14 }}>
                  <Plot
                    data={[
                      { x: ptsCl.map((p) => p.alpha), y: ptsCl.map((p) => p.cl), type: 'scatter', mode: 'lines+markers', name: 'CFD Cl(α)' },
                      ...(pentePortance && ptsCl.length >= 2 ? [{ x: [ptsCl[0].alpha, ptsCl[ptsCl.length - 1].alpha], y: [pentePortance.pente * ptsCl[0].alpha + pentePortance.ordonnee, pentePortance.pente * ptsCl[ptsCl.length - 1].alpha + pentePortance.ordonnee], type: 'scatter', mode: 'lines', name: 'Régression linéaire', line: { dash: 'dash', color: '#64748b' } }] : []),
                      ...(refPolarData ? [{ x: refPolarData.alpha, y: refPolarData.cl, type: 'scatter', mode: 'markers', name: `Réf. (${refPolarData.nom})`, marker: { size: 7, symbol: 'circle-open', color: '#dc2626' } }] : []),
                    ]}
                    layout={{ autosize: true, height: 390, title: { text: 'Portance Cl(α)', font: { size: 15 } }, xaxis: { title: { text: 'α (°)', standoff: 10 } }, yaxis: { title: { text: 'Cl' } }, legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.28 }, margin: { b: 95 }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff' }}
                    style={{ width: '100%' }}
                    useResizeHandler
                    onInitialized={(_, g) => { polarRefs.current.cl = g; activePlotRef.current = g }}
                    onUpdate={(_, g) => { polarRefs.current.cl = g; activePlotRef.current = g }}
                  />
                  <Plot
                    data={[
                      { x: ptsCd.map((p) => p.alpha), y: ptsCd.map((p) => p.cd), type: 'scatter', mode: 'lines+markers', name: 'CFD Cd(α)', line: { color: '#dc2626' } },
                      ...(refPolarData && refPolarData.cd.some((v) => v !== null) ? [{ x: refPolarData.alpha, y: refPolarData.cd, type: 'scatter', mode: 'markers', name: `Réf. (${refPolarData.nom})`, marker: { size: 7, symbol: 'circle-open', color: '#1e293b' } }] : []),
                    ]}
                    layout={{ autosize: true, height: 390, title: { text: 'Traînée Cd(α)', font: { size: 15 } }, xaxis: { title: { text: 'α (°)', standoff: 10 } }, yaxis: { title: { text: 'Cd' } }, legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.28 }, margin: { b: 95 }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff' }}
                    style={{ width: '100%' }}
                    useResizeHandler
                    onInitialized={(_, g) => { polarRefs.current.cd = g }}
                    onUpdate={(_, g) => { polarRefs.current.cd = g }}
                  />
                  <Plot
                    data={[{ x: ptsFin.map((p) => p.alpha), y: ptsFin.map((p) => p.finesse), type: 'scatter', mode: 'lines+markers', name: 'Cl/Cd(α)', line: { color: '#0f766e' } }]}
                    layout={{ autosize: true, height: 360, title: { text: 'Finesse Cl/Cd(α)', font: { size: 15 } }, xaxis: { title: { text: 'α (°)' } }, yaxis: { title: { text: 'Cl / Cd' } }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff' }}
                    style={{ width: '100%' }}
                    useResizeHandler
                    onInitialized={(_, g) => { polarRefs.current.fin = g }}
                    onUpdate={(_, g) => { polarRefs.current.fin = g }}
                  />
                  <Plot
                    data={[{ x: ptsLil.map((p) => p.cd), y: ptsLil.map((p) => p.cl), text: ptsLil.map((p) => `α = ${p.alpha}°`), type: 'scatter', mode: 'lines+markers', name: 'Cl(Cd)', line: { color: '#7c3aed' } }]}
                    layout={{ autosize: true, height: 360, title: { text: 'Polaire de Lilienthal Cl(Cd)', font: { size: 15 } }, xaxis: { title: { text: 'Cd' } }, yaxis: { title: { text: 'Cl' } }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff' }}
                    style={{ width: '100%' }}
                    useResizeHandler
                    onInitialized={(_, g) => { polarRefs.current.lil = g }}
                    onUpdate={(_, g) => { polarRefs.current.lil = g }}
                  />
                </div>
              )}

              {pointsPolaireBruts.length > 0 && (
                <div style={{ overflowX: 'auto', marginTop: 16 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Inclure</th>
                        <th style={thStyle}>Simulation</th>
                        <th style={thStyle}>α (°)</th>
                        <th style={thStyle}>Cl (-)</th>
                        <th style={thStyle}>Cd (-)</th>
                        <th style={thStyle}>Finesse (Cl/Cd)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pointsPolaireBruts.map((pt) => {
                        const checked = pt.hasData && !excludedPolarIds.includes(pt.id)
                        return (
                          <tr key={pt.id} style={pt.hasData ? undefined : { backgroundColor: '#f8fafc', color: '#94a3b8' }}>
                            <td style={tdStyle}>
                              <input type="checkbox" disabled={!pt.hasData} checked={checked} onChange={() => setExcludedPolarIds((prev) => (checked ? [...prev, pt.id] : prev.filter((id) => id !== pt.id)))} />
                            </td>
                            <td style={{ ...tdStyle, fontWeight: 600 }}>{pt.nom}</td>
                            <td style={tdStyle}>{formaterNombre(pt.alpha)}</td>
                            <td style={tdStyle}>{pt.hasData ? formaterNombre(pt.cl) : 'Données manquantes'}</td>
                            <td style={tdStyle}>{pt.hasData ? formaterNombre(pt.cd) : 'Données manquantes'}</td>
                            <td style={tdStyle}>{formaterNombre(pt.finesse)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ONGLET ÉCOULEMENT INTERNE : BILANS */}
          {isInterne && activeTab === 'interne_bilans' && (
            <div className="card">
              <h2>Bilans, Répartition des débits & Pertes — {simActive.nom}</h2>
              {bilanMasse && (
                <div style={{ marginBottom: 20 }}>
                  <h3 style={{ margin: '0 0 8px 0', fontSize: 15 }}>Bilan de masse détaillé</h3>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr><th style={thStyle}>Grandeur</th><th style={thStyle}>Débit massique (kg/s)</th><th style={thStyle}>Statut</th></tr></thead>
                      <tbody>
                        <tr><td style={tdStyle}>Total entrées</td><td style={{ ...tdStyle, fontWeight: 600 }}>{formaterNombre(bilanMasse.total_entrees)}</td><td style={tdStyle}>—</td></tr>
                        <tr><td style={tdStyle}>Total sorties</td><td style={{ ...tdStyle, fontWeight: 600 }}>{formaterNombre(bilanMasse.total_sorties)}</td><td style={tdStyle}>—</td></tr>
                        <tr>
                          <td style={tdStyle}>Écart absolu / relatif</td>
                          <td style={{ ...tdStyle, fontWeight: 600 }}>{formaterNombre(bilanMasse.ecart_absolu)} kg/s ({formaterNombre(bilanMasse.ecart_relatif_pct)} %)</td>
                          <td style={tdStyle}>
                            <span style={badgeStyle(bilanMasse.ecart_relatif_pct > 1 ? '#fee2e2' : bilanMasse.ecart_relatif_pct > 0.1 ? '#fef3c7' : '#dcfce7', bilanMasse.ecart_relatif_pct > 1 ? '#991b1b' : bilanMasse.ecart_relatif_pct > 0.1 ? '#92400e' : '#166534')}>
                              {bilanMasse.ecart_relatif_pct > 1 ? 'Erreur (> 1%)' : bilanMasse.ecart_relatif_pct > 0.1 ? 'Attention (> 0,1%)' : 'Conforme (≤ 0,1%)'}
                            </span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 16 }}>
                {pressionCascade && (
                  <Plot
                    data={[{ type: 'waterfall', x: ['P0 entrée', 'Perte ΔP totale', 'P0 sortie'], measure: ['absolute', 'relative', 'total'], y: [pressionCascade.p0_entree, -pressionCascade.dp_totale, pressionCascade.p0_sortie], text: [`${formaterNombre(pressionCascade.p0_entree)} Pa`, `−${formaterNombre(pressionCascade.dp_totale)} Pa`, `${formaterNombre(pressionCascade.p0_sortie)} Pa`], textposition: 'outside', decreasing: { marker: { color: '#dc2626' } }, totals: { marker: { color: '#2563eb' } } }]}
                    layout={{ autosize: true, height: 360, title: { text: 'Cascade de pression totale P0 (Pa)', font: { size: 15 } }, yaxis: { title: { text: 'Pression totale (Pa)' }, showgrid: true, gridcolor: '#e2e8f0' }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff' }}
                    style={{ width: '100%' }}
                    useResizeHandler
                    onInitialized={(_, g) => { activePlotRef.current = g }}
                    onUpdate={(_, g) => { activePlotRef.current = g }}
                  />
                )}
                {repartitionDebits && (
                  <Plot
                    data={[{ x: Object.keys(repartitionDebits), y: Object.values(repartitionDebits), type: 'bar', text: Object.values(repartitionDebits).map((v) => `${v}%`), textposition: 'auto', marker: { color: '#2563eb' } }]}
                    layout={{ autosize: true, height: 360, title: { text: 'Répartition du débit par sortie (%)', font: { size: 15 } }, xaxis: { title: { text: 'Sortie' } }, yaxis: { title: { text: 'Part du débit (%)' }, range: [0, 105] }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff' }}
                    style={{ width: '100%' }}
                    useResizeHandler
                  />
                )}
              </div>

              {profilsAxiauxInterne.map(([nomProfil, data]) => (
                <Plot key={nomProfil} data={[{ x: data.x_c, y: data.valeur, type: 'scatter', mode: 'lines', name: nomProfil }]} layout={{ autosize: true, height: 360, title: { text: `Profil extrait : ${nomProfil} (${data.source})`, font: { size: 15 } }, xaxis: { title: { text: 'Position (m)' } }, yaxis: { title: { text: nomProfil } }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff' }} style={{ width: '100%', marginTop: 16 }} useResizeHandler />
              ))}
            </div>
          )}

          {/* ONGLET COURBE ΔP(Q) DU PROJET (avec R² — REV-39) */}
          {isInterne && activeTab === 'interne_carac' && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                <h2 style={{ margin: 0 }}>Courbe ΔP(Q) du projet « {simActive.projet || 'Défaut'} »</h2>
                {fitInterne && (
                  <span style={badgeStyle('#e0e7ff', '#3730a3')}>
                    ΔP = {formaterNombre(fitInterne.a)} · Q² &nbsp;|&nbsp; R² = {fitInterne.r2.toFixed(4).replace('.', ',')}
                  </span>
                )}
              </div>

              {pointsInterneValides.length < 2 ? (
                <div style={{ padding: 16, marginTop: 12, backgroundColor: '#f8fafc', borderRadius: 8, color: '#475569' }}>Au moins 2 simulations avec débit et ΔP sont nécessaires.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 16, marginTop: 14 }}>
                  <Plot
                    data={[
                      { x: pointsInterneValides.map((p) => p.debit), y: pointsInterneValides.map((p) => p.dpTot ?? p.dpStat), type: 'scatter', mode: 'markers', name: 'Simulations CFD', marker: { size: 9, color: '#2563eb' } },
                      ...(fitInterne ? [{ x: Array.from({ length: 40 }, (_, i) => (Math.max(...pointsInterneValides.map((p) => p.debit || 0)) * i) / 39), y: Array.from({ length: 40 }, (_, i) => { const q = (Math.max(...pointsInterneValides.map((p) => p.debit || 0)) * i) / 39; return fitInterne.a * q * q }), type: 'scatter', mode: 'lines', name: `ΔP = ${formaterNombre(fitInterne.a)}·Q² (R²=${fitInterne.r2.toFixed(4)})`, line: { dash: 'dash', color: '#dc2626' } }] : []),
                    ]}
                    layout={{ autosize: true, height: 380, title: { text: 'Perte de charge ΔP en fonction du débit', font: { size: 15 } }, xaxis: { title: { text: 'Débit massique Q (kg/s)' }, showgrid: true, gridcolor: '#e2e8f0' }, yaxis: { title: { text: 'ΔP (Pa)' }, showgrid: true, gridcolor: '#e2e8f0' }, legend: { orientation: 'h', y: -0.24 }, margin: { b: 85 }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff' }}
                    style={{ width: '100%' }}
                    useResizeHandler
                    onInitialized={(_, g) => { activePlotRef.current = g }}
                    onUpdate={(_, g) => { activePlotRef.current = g }}
                  />
                  <Plot
                    data={[{ x: pointsInterneValides.map((p) => p.re), y: pointsInterneValides.map((p) => p.kPerte), type: 'scatter', mode: 'lines+markers', name: 'K(Re)', line: { color: '#0f766e' } }]}
                    layout={{ autosize: true, height: 380, title: { text: 'Coefficient de perte K en fonction de Re', font: { size: 15 } }, xaxis: { title: { text: 'Nombre de Reynolds Re' }, showgrid: true, gridcolor: '#e2e8f0' }, yaxis: { title: { text: 'K (-)' }, showgrid: true, gridcolor: '#e2e8f0' }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff' }}
                    style={{ width: '100%' }}
                    useResizeHandler
                  />
                </div>
              )}

              {pointsInterne.length > 0 && (
                <div style={{ overflowX: 'auto', marginTop: 16 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Simulation</th>
                        <th style={thStyle}>Débit (kg/s)</th>
                        <th style={thStyle}>ΔP statique (Pa)</th>
                        <th style={thStyle}>ΔP totale (Pa)</th>
                        <th style={thStyle}>K (-)</th>
                        <th style={thStyle}>Re (-)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pointsInterne.map((pt) => (
                        <tr key={pt.id}>
                          <td style={{ ...tdStyle, fontWeight: 600 }}>{pt.nom}</td>
                          <td style={tdStyle}>{formaterNombre(pt.debit)}</td>
                          <td style={tdStyle}>{formaterNombre(pt.dpStat)}</td>
                          <td style={tdStyle}>{formaterNombre(pt.dpTot)}</td>
                          <td style={tdStyle}>{formaterNombre(pt.kPerte)}</td>
                          <td style={tdStyle}>{formaterNombre(pt.re)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}