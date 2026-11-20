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
  converge: { label: 'Convergé', bg: '#dcfce7', color: '#166534' },
  limite: { label: 'Limite', bg: '#fef3c7', color: '#92400e' },
  non_converge: { label: 'Non convergé', bg: '#fee2e2', color: '#991b1b' },
  constante: { label: 'Constante', bg: '#e2e8f0', color: '#475569' },
}

function normaliserKpi(val) {
  if (val !== null && typeof val === 'object' && 'valeur' in val) {
    return val
  }
  return {
    valeur: typeof val === 'number' ? val : Number(val),
    ecart_type: null,
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

async function chargerImageBase64(url) {
  const response = await fetch(url)
  const blob = await response.blob()
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
  const dimensions = await new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = reject
    img.src = dataUrl
  })
  return { dataUrl, ...dimensions }
}

function estLigneNumerique(ligne) {
  const tokens = ligne.trim().split(/[\s,;]+/).filter(Boolean)
  if (tokens.length < 2) return false
  return tokens.every((t) => !Number.isNaN(Number(t)))
}

function parserFichierFluent(texte, nomFichier = 'local') {
  const lignes = texte.split(/\r?\n/)
  const debutDonnees = lignes.findIndex((l) => estLigneNumerique(l))
  if (debutDonnees === -1) {
    throw new Error('Aucune donnée numérique détectée dans ce fichier.')
  }

  let colonnes = null
  for (let i = debutDonnees - 1; i >= 0; i--) {
    const lStrip = lignes[i].trim()
    if (!lStrip) continue
    if (lStrip.startsWith('(') && lStrip.endsWith(')')) {
      const matches = [...lStrip.matchAll(/"([^"]+)"/g)].map((m) => m[1])
      if (matches.length > 0) {
        colonnes = matches
        break
      }
    }
    const lClean = lStrip.replace(/^[#%]+/, '').trim()
    if (lClean && !lClean.startsWith('"Report')) {
      const candidats = lClean
        .split(/[\t,;]+|\s{2,}/)
        .map((c) => c.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      if (candidats.length >= 2) {
        colonnes = candidats
        break
      }
    }
  }

  const ligneRef = lignes[debutDonnees].trim()
  const sepRegex = ligneRef.includes(',') ? /,/ : ligneRef.includes(';') ? /;/ : /\s+/

  const lignesValides = []
  for (let i = debutDonnees; i < lignes.length; i++) {
    const l = lignes[i].trim()
    if (!l) continue
    const vals = l.split(sepRegex).filter(Boolean).map(Number)
    if (vals.length >= 2 && vals.every((v) => !Number.isNaN(v))) {
      lignesValides.push(vals)
    }
  }

  if (lignesValides.length === 0) {
    throw new Error('Impossible de lire les valeurs numériques du fichier.')
  }

  const nbCols = lignesValides[0].length
  const nomsColonnes =
    colonnes && colonnes.length === nbCols
      ? colonnes
      : Array.from({ length: nbCols }, (_, idx) => `Col_${idx}`)

  const donnees = lignesValides
    .filter((row) => row.length === nbCols)
    .map((row) => {
      const obj = {}
      nomsColonnes.forEach((col, idx) => {
        obj[col] = row[idx]
      })
      return obj
    })

  const kpiFinaux = {}
  const nWin = Math.min(100, donnees.length)
  const sliceFin = donnees.slice(-nWin)
  const colsKpi = nomsColonnes.slice(1).filter((c) => c.toLowerCase() !== 'flow-time')
  const cibles = colsKpi.length > 0 ? colsKpi : nomsColonnes.slice(1)

  for (const col of cibles) {
    const vals = sliceFin.map((r) => r[col])
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length
    const std = Math.sqrt(variance)
    const range = Math.max(...vals) - Math.min(...vals)
    const varRel = Math.abs(mean) > 1e-12 ? (range / Math.abs(mean)) * 100 : range * 100
    const convergence =
      range === 0 ? 'constante' : varRel <= 0.1 ? 'converge' : varRel <= 1.0 ? 'limite' : 'non_converge'

    kpiFinaux[col] = {
      valeur: Number(mean.toFixed(6)),
      ecart_type: Number(std.toFixed(6)),
      variation_rel_pct: Number(varRel.toFixed(4)),
      unite: '-',
      methode: 'moyenne_finale',
      fenetre: nWin,
      convergence,
      source: `${nomFichier}:${col}`,
    }
  }

  return { donnees, kpiFinaux }
}

function parserRefCpCsv(texte, nomFichier) {
  const lignes = texte.split(/\r?\n/)
  const x = []
  const y = []
  for (const l of lignes) {
    if (!estLigneNumerique(l)) continue
    const parts = l.trim().split(/[\s,;]+/).map(Number)
    if (parts.length >= 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
      x.push(parts[0])
      y.push(parts[1])
    }
  }
  if (x.length === 0) throw new Error('Aucune donnée numérique (x/c, Cp) trouvée dans le CSV de référence.')
  return { nom: nomFichier, x, y }
}

function extraireAxes(donnees) {
  const cles = donnees.length > 0 ? Object.keys(donnees[0]) : []
  const hasFlowTime = cles.includes('flow-time')
  const axeX = hasFlowTime ? 'flow-time' : cles[0]
  const variablesY = cles.filter((cle) => cle !== axeX && cle !== cles[0])
  return { hasFlowTime, axeX, variablesY }
}

function creerLayoutPlotly(titre, axes, height = 460, yScale = 'linear') {
  return {
    autosize: true,
    height,
    title: { text: titre, font: { size: 15, color: '#1e293b' } },
    showlegend: true,
    legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.22 },
    xaxis: {
      title: { text: axes.hasFlowTime ? 'Flow Time (s)' : axes.axeX, font: { size: 13, color: '#1e293b' } },
      showgrid: true,
      gridcolor: '#e2e8f0',
    },
    yaxis: {
      type: yScale,
      title: { text: axes.variablesY.length === 1 ? axes.variablesY[0] : 'Valeur', font: { size: 13, color: '#1e293b' } },
      showgrid: true,
      gridcolor: '#e2e8f0',
    },
    paper_bgcolor: '#ffffff',
    plot_bgcolor: '#ffffff',
    font: { color: '#1e293b' },
    margin: { t: 55, r: 25, l: 75, b: 85 },
  }
}

export default function App() {
  const [simulations, setSimulations] = useState([])
  const [loadingSims, setLoadingSims] = useState(true)
  const [selectedSim, setSelectedSim] = useState(null)
  const [convergence, setConvergence] = useState([])

  // Onglet actif (piloté par le profil)
  const [activeTab, setActiveTab] = useState('synthese')
  const [refCpData, setRefCpData] = useState(null)

  // Filtres & recherche (UI-01)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterProfil, setFilterProfil] = useState('tous')
  const [filterStatut, setFilterStatut] = useState('tous')

  // Échelle Y (UI-05)
  const [yScale, setYScale] = useState('linear')

  // Mode comparaison
  const [compareMode, setCompareMode] = useState(false)
  const [compareLayout, setCompareLayout] = useState('superpose')
  const [selectedSimB, setSelectedSimB] = useState(null)
  const [convergenceB, setConvergenceB] = useState([])

  const [exportingPdf, setExportingPdf] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [isDragging, setIsDragging] = useState(false)

  const plotDivRef = useRef(null)
  const plotDivRefB = useRef(null)

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

  // Réinitialiser l'onglet si le profil change
  useEffect(() => {
    if (!selectedSim) return
    if (selectedSim.profil_type !== 'aile_2d' && (activeTab === 'paroi' || activeTab === 'polaires')) {
      setActiveTab('synthese')
    }
    if (selectedSim.profil_type !== 'interne' && (activeTab === 'interne_bilans' || activeTab === 'interne_carac')) {
      setActiveTab('synthese')
    }
  }, [selectedSim, activeTab])

  const simulationsFiltrees = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return simulations.filter((sim) => {
      if (filterProfil !== 'tous' && (sim.profil_type || 'generique') !== filterProfil) return false
      if (filterStatut !== 'tous' && (sim.statut || 'complete') !== filterStatut) return false
      if (!q) return true
      const matchNom = sim.nom?.toLowerCase().includes(q)
      const matchProjet = sim.projet?.toLowerCase().includes(q)
      const matchTags = (sim.tags || []).some((t) => t.toLowerCase().includes(q))
      return matchNom || matchProjet || matchTags
    })
  }, [simulations, searchQuery, filterProfil, filterStatut])

  // Synchroniser selectedSim avec les résultats filtrés (y compris si 0 résultat)
  useEffect(() => {
    if (simulationsFiltrees.length === 0) {
      setSelectedSim(null)
    } else if (!simulationsFiltrees.some((s) => s.id === selectedSim?.id)) {
      setSelectedSim(simulationsFiltrees[0])
    }
  }, [simulationsFiltrees, selectedSim])

  useEffect(() => {
    if (!selectedSim) {
      setConvergence([])
      return
    }
    if (selectedSim.isLocal) {
      setConvergence(selectedSim.localConvergence || [])
      return
    }
    async function chargerConvergence() {
      const { data } = await supabase
        .from('convergence_data')
        .select('donnees')
        .eq('simulation_id', selectedSim.id)
        .single()
      setConvergence(data?.donnees || [])
    }
    chargerConvergence()
  }, [selectedSim])

  useEffect(() => {
    if (!compareMode || !selectedSimB) {
      setConvergenceB([])
      return
    }
    if (selectedSimB.isLocal) {
      setConvergenceB(selectedSimB.localConvergence || [])
      return
    }
    async function chargerConvergenceB() {
      const { data } = await supabase
        .from('convergence_data')
        .select('donnees')
        .eq('simulation_id', selectedSimB.id)
        .single()
      setConvergenceB(data?.donnees || [])
    }
    chargerConvergenceB()
  }, [compareMode, selectedSimB])

  // Polaires Aile 2D (Phase 1)
  const pointsPolaire = useMemo(() => {
    if (!selectedSim || selectedSim.profil_type !== 'aile_2d') return []
    const nomProfilCible = selectedSim.metadonnees?.profil
    if (!nomProfilCible) return []

    return simulations
      .filter(
        (s) =>
          s.profil_type === 'aile_2d' &&
          s.metadonnees?.profil === nomProfilCible &&
          s.metadonnees?.alpha !== undefined
      )
      .map((s) => {
        const alpha = Number(s.metadonnees.alpha)
        const cl = trouverValeurKpi(s.kpi_finaux, ['cl', 'cl-1', 'lift-coeff', 'portance'])
        const cd = trouverValeurKpi(s.kpi_finaux, ['cd', 'cd-1', 'drag-coeff', 'trainee'])
        const finesse = cl !== null && cd !== null && Math.abs(cd) > 1e-12 ? cl / cd : null
        return { id: s.id, nom: s.nom, alpha, cl, cd, finesse }
      })
      .sort((a, b) => a.alpha - b.alpha)
  }, [simulations, selectedSim])

  // Courbe caractéristique Écoulement interne ΔP(Q) & K(Re) (Phase 2)
  const pointsInterne = useMemo(() => {
    if (!selectedSim || selectedSim.profil_type !== 'interne') return []
    const projetCible = selectedSim.projet || 'Défaut'

    return simulations
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
  }, [simulations, selectedSim])

  const activerDesactiverComparaison = () => {
    const next = !compareMode
    setCompareMode(next)
    if (next) setActiveTab('synthese')
    if (next && !selectedSimB && simulations.length > 1) {
      const autre = simulations.find((s) => s.id !== selectedSim?.id) || simulations[0]
      setSelectedSimB(autre)
    }
  }

  const reinitialiserFiltres = () => {
    setSearchQuery('')
    setFilterProfil('tous')
    setFilterStatut('tous')
  }

  const traiterFichierLocal = async (file) => {
    if (!file) return
    setUploadError('')
    try {
      const texte = await file.text()
      const { donnees, kpiFinaux } = parserFichierFluent(texte, file.name)
      const nomPropre = file.name.replace(/\.[^/.]+$/, '')

      const simLocale = {
        id: `local-${Date.now()}`,
        nom: `${nomPropre} (Local)`,
        description: `Fichier importé manuellement : ${file.name} (${donnees.length} lignes)`,
        profil_type: 'generique',
        profil_version: '1.0',
        statut: 'complete',
        projet: 'Import local',
        tags: ['local'],
        metadonnees: {},
        validation: { statut: 'OK', messages: [] },
        kpi_finaux: kpiFinaux,
        profils_paroi: {},
        url_visuel_3d: null,
        isLocal: true,
        localConvergence: donnees,
      }

      setSimulations((prev) => [simLocale, ...prev])
      reinitialiserFiltres()
      setSelectedSim(simLocale)
    } catch (err) {
      setUploadError(err.message || 'Erreur lors de la lecture du fichier.')
    }
  }

  const chargerRefCp = async (file) => {
    if (!file) return
    try {
      const texte = await file.text()
      setRefCpData(parserRefCpCsv(texte, file.name))
    } catch (err) {
      alert(err.message)
    }
  }

  const attacherImageLocale = (file) => {
    if (!file || !selectedSim) return
    const imageUrl = URL.createObjectURL(file)
    const simMaj = { ...selectedSim, url_visuel_3d: imageUrl }
    setSelectedSim(simMaj)
    setSimulations((prev) => prev.map((s) => (s.id === simMaj.id ? simMaj : s)))
  }

  const exporterCSV = (donnees, nom) => {
    if (!donnees || donnees.length === 0) return
    const cles = Object.keys(donnees[0])
    const lignes = [cles.join(','), ...donnees.map((row) => cles.map((c) => row[c]).join(','))]
    const blob = new Blob([lignes.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${nom}_courbes.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const isComparing = compareMode && selectedSim && selectedSimB
  const axesA = extraireAxes(convergence)
  const axesB = extraireAxes(convergenceB)

  const tracesA = axesA.variablesY.map((varY) => ({
    x: convergence.map((row) => row[axesA.axeX]),
    y: convergence.map((row) => row[varY]),
    type: 'scatter',
    mode: 'lines',
    name: isComparing && compareLayout === 'superpose' ? `${varY} (${selectedSim.nom})` : varY,
    line: { width: 2 },
  }))

  const tracesB = isComparing
    ? axesB.variablesY.map((varY) => ({
        x: convergenceB.map((row) => row[axesB.axeX]),
        y: convergenceB.map((row) => row[varY]),
        type: 'scatter',
        mode: 'lines',
        name: compareLayout === 'superpose' ? `${varY} (${selectedSimB.nom})` : varY,
        line: { width: 2, dash: compareLayout === 'superpose' ? 'dash' : 'solid' },
      }))
    : []

  const tracesSuperposees = [...tracesA, ...tracesB]

  const kpiComparatif = isComparing
    ? Array.from(
        new Set([
          ...Object.keys(selectedSim.kpi_finaux || {}),
          ...Object.keys(selectedSimB.kpi_finaux || {}),
        ])
      ).map((cle) => {
        const kA = selectedSim.kpi_finaux?.[cle] !== undefined ? normaliserKpi(selectedSim.kpi_finaux[cle]) : null
        const kB = selectedSimB.kpi_finaux?.[cle] !== undefined ? normaliserKpi(selectedSimB.kpi_finaux[cle]) : null
        const hasBoth = kA && kB && !Number.isNaN(kA.valeur) && !Number.isNaN(kB.valeur)
        const delta = hasBoth ? kB.valeur - kA.valeur : null
        const pct = hasBoth && kA.valeur !== 0 ? ((kB.valeur - kA.valeur) / Math.abs(kA.valeur)) * 100 : null
        return { cle, kA, kB, delta, pct }
      })
    : []

  const telechargerGraphique = async (ref, nomFichier) => {
    if (!ref.current) return
    await Plotly.downloadImage(ref.current, {
      format: 'png',
      width: 1600,
      height: 800,
      filename: nomFichier,
    })
  }

  const telechargerImageCFD = async (url, nom) => {
    if (!url) return
    try {
      const response = await fetch(url)
      const blob = await response.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = `${nom}_champ_cfd.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(blobUrl)
    } catch {
      window.open(url, '_blank')
    }
  }

  const exporterPDF = async () => {
    if (!selectedSim) return
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
      doc.text(
        isComparing ? 'Rapport Comparatif CFD — ANSYS Fluent' : 'Rapport de Post-Traitement CFD — ANSYS Fluent',
        margin,
        14
      )

      doc.setFontSize(10)
      doc.setFont('helvetica', 'normal')
      const dateStr = new Date().toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })
      const sousTitre = isComparing
        ? `A : ${selectedSim.nom}   vs   B : ${selectedSimB.nom}   |   ${dateStr}`
        : `Simulation : ${selectedSim.nom} (${PROFIL_LABELS[selectedSim.profil_type] || 'Générique'})   |   ${dateStr}`
      doc.text(sousTitre, margin, 24)

      let y = 44
      doc.setTextColor(30, 41, 59)

      if (isComparing && kpiComparatif.length > 0) {
        doc.setFontSize(13)
        doc.setFont('helvetica', 'bold')
        doc.text('1. Comparaison des indicateurs clés (KPI)', margin, y)
        y += 4
        autoTable(doc, {
          startY: y,
          head: [['KPI', selectedSim.nom, selectedSimB.nom, 'Écart (B - A)', 'Écart (%)']],
          body: kpiComparatif.map((row) => [
            row.cle,
            row.kA ? `${row.kA.valeur}${row.kA.unite !== '-' ? ' ' + row.kA.unite : ''}` : '—',
            row.kB ? `${row.kB.valeur}${row.kB.unite !== '-' ? ' ' + row.kB.unite : ''}` : '—',
            row.delta !== null ? `${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(6)}` : '—',
            row.pct !== null ? `${row.pct >= 0 ? '+' : ''}${row.pct.toFixed(2)} %` : '—',
          ]),
          theme: 'striped',
          headStyles: { fillColor: [37, 99, 235], textColor: 255 },
          margin: { left: margin, right: margin },
        })
        y = doc.lastAutoTable.finalY + 12
      } else {
        const kpiEntries = Object.entries(selectedSim.kpi_finaux || {})
        if (kpiEntries.length > 0) {
          doc.setFontSize(13)
          doc.setFont('helvetica', 'bold')
          doc.text('1. Indicateurs clés moyennés & calculés', margin, y)
          y += 4
          autoTable(doc, {
            startY: y,
            head: [['KPI', 'Valeur', 'Écart-type (σ)', 'Unité', 'Convergence']],
            body: kpiEntries.map(([k, v]) => {
              const kpi = normaliserKpi(v)
              return [
                k,
                String(kpi.valeur),
                kpi.ecart_type !== null ? `± ${kpi.ecart_type}` : '—',
                kpi.unite || '-',
                CONV_STYLES[kpi.convergence]?.label || '—',
              ]
            }),
            theme: 'striped',
            headStyles: { fillColor: [37, 99, 235], textColor: 255 },
            margin: { left: margin, right: margin },
          })
          y = doc.lastAutoTable.finalY + 12
        }
      }

      if (activeTab === 'synthese') {
        if (isComparing && compareLayout === 'cote_a_cote') {
          const halfWidth = (contentWidth - 6) / 2
          const plotHeight = halfWidth * (550 / 800)
          if (y + plotHeight + 14 > pageHeight - 15) {
            doc.addPage()
            y = 20
          }
          doc.setFontSize(13)
          doc.setFont('helvetica', 'bold')
          doc.text('2. Courbes de convergence (côte à côte)', margin, y)
          y += 5
          if (plotDivRef.current) {
            const imgA = await Plotly.toImage(plotDivRef.current, { format: 'png', width: 800, height: 550 })
            doc.addImage(imgA, 'PNG', margin, y, halfWidth, plotHeight)
          }
          if (plotDivRefB.current) {
            const imgB = await Plotly.toImage(plotDivRefB.current, { format: 'png', width: 800, height: 550 })
            doc.addImage(imgB, 'PNG', margin + halfWidth + 6, y, halfWidth, plotHeight)
          }
          y += plotHeight + 12
        } else if (tracesSuperposees.length > 0 && plotDivRef.current) {
          const plotImgData = await Plotly.toImage(plotDivRef.current, { format: 'png', width: 1200, height: 600 })
          const plotHeight = contentWidth * (600 / 1200)
          if (y + plotHeight + 14 > pageHeight - 15) {
            doc.addPage()
            y = 20
          }
          doc.setFontSize(13)
          doc.setFont('helvetica', 'bold')
          doc.text(isComparing ? '2. Courbes de convergence superposées' : '2. Courbes de convergence', margin, y)
          y += 5
          doc.addImage(plotImgData, 'PNG', margin, y, contentWidth, plotHeight)
          y += plotHeight + 12
        }
      }

      if (!isComparing && (selectedSim.validation?.messages?.length > 0 || selectedSim.script_version)) {
        if (y + 30 > pageHeight - 15) {
          doc.addPage()
          y = 20
        }
        doc.setFontSize(11)
        doc.setFont('helvetica', 'bold')
        doc.text('Traçabilité & Contrôles qualité', margin, y)
        y += 5
        doc.setFontSize(9)
        doc.setFont('helvetica', 'normal')
        doc.text(
          `Script v${selectedSim.script_version || '1.0'} | Profil ${selectedSim.profil_type || 'generique'} v${selectedSim.profil_version || '1.0'} | Statut : ${selectedSim.statut || 'complete'}`,
          margin,
          y
        )
        y += 5
        for (const msg of selectedSim.validation?.messages || []) {
          const lines = doc.splitTextToSize(`• ${msg}`, contentWidth)
          doc.text(lines, margin, y)
          y += lines.length * 4 + 1
        }
      }

      const totalPages = doc.internal.getNumberOfPages()
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i)
        doc.setFontSize(8)
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(120, 120, 120)
        doc.text('CFD Post-Pro • cfdpost.netlify.app', margin, pageHeight - 8)
        doc.text(`Page ${i} / ${totalPages}`, pageWidth - margin, pageHeight - 8, { align: 'right' })
      }

      const nomPdf = isComparing
        ? `Comparaison_CFD_${selectedSim.nom}_vs_${selectedSimB.nom}.pdf`
        : `Rapport_CFD_${selectedSim.nom}.pdf`
      doc.save(nomPdf)
    } finally {
      setExportingPdf(false)
    }
  }

  const btnStyle = {
    padding: '8px 14px',
    borderRadius: 6,
    border: 'none',
    backgroundColor: '#2563eb',
    color: '#ffffff',
    fontWeight: 600,
    cursor: 'pointer',
  }

  const tabBtnStyle = (actif) => ({
    padding: '9px 16px',
    borderRadius: 8,
    border: actif ? '1px solid #2563eb' : '1px solid #cbd5e1',
    backgroundColor: actif ? '#2563eb' : '#ffffff',
    color: actif ? '#ffffff' : '#1e293b',
    fontWeight: 600,
    cursor: 'pointer',
  })

  const badgeStyle = (bg, color) => ({
    display: 'inline-block',
    padding: '3px 10px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    backgroundColor: bg,
    color,
  })

  const thStyle = { textAlign: 'left', padding: '10px 12px', borderBottom: '2px solid #cbd5e1', backgroundColor: '#f8fafc' }
  const tdStyle = { padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }

  const statutInfo = STATUT_STYLES[selectedSim?.statut || 'complete'] || STATUT_STYLES.complete
  const metaEntries = Object.entries(selectedSim?.metadonnees || {})
  const paroi = selectedSim?.profils_paroi || {}
  const isAile2D = !isComparing && selectedSim?.profil_type === 'aile_2d'
  const isInterne = !isComparing && selectedSim?.profil_type === 'interne'

  const repartitionDebits = paroi.repartition_debits || null
  const profilsAxiauxInterne = Object.entries(paroi).filter(
    ([k, v]) => k !== 'repartition_debits' && v && Array.isArray(v.x_c)
  )

  return (
    <div className="container">
      <h1>Post-Traitement CFD — ANSYS Fluent</h1>

      {/* Zone d'upload manuel */}
      <div
        className="card"
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragging(false)
          traiterFichierLocal(e.dataTransfer.files?.[0])
        }}
        style={{
          border: isDragging ? '2px dashed #2563eb' : '2px dashed #cbd5e1',
          backgroundColor: isDragging ? '#eff6ff' : undefined,
          textAlign: 'center',
          padding: 18,
          transition: 'all 0.2s',
        }}
      >
        <p style={{ margin: '0 0 10px 0', fontWeight: 600 }}>
          📂 Post-traitement rapide : glissez-déposez un fichier Fluent (.out, .csv, .txt, .xy)
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
          <label style={btnStyle}>
            Choisir un fichier de données
            <input
              type="file"
              accept=".out,.csv,.txt,.xy"
              style={{ display: 'none' }}
              onChange={(e) => {
                traiterFichierLocal(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </label>
          {selectedSim?.isLocal && (
            <label style={{ ...btnStyle, backgroundColor: '#475569' }}>
              🖼️ Ajouter une image CFD (.png/.jpg)
              <input
                type="file"
                accept="image/png,image/jpeg"
                style={{ display: 'none' }}
                onChange={(e) => {
                  attacherImageLocale(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </label>
          )}
        </div>
        {uploadError && (
          <p style={{ color: '#dc2626', marginTop: 10, marginBottom: 0, fontWeight: 600 }}>⚠️ {uploadError}</p>
        )}
      </div>

      {/* Recherche, Filtres & Sélection */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="🔍 Rechercher par nom, projet ou tag..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ flex: '1 1 220px', padding: '8px 12px', borderRadius: 6, border: '1px solid #cbd5e1' }}
          />
          <select
            value={filterProfil}
            onChange={(e) => setFilterProfil(e.target.value)}
            style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1' }}
          >
            <option value="tous">Tous les profils</option>
            <option value="generique">Générique</option>
            <option value="aile_2d">Aile 2D</option>
            <option value="interne">Écoulement interne</option>
          </select>
          <select
            value={filterStatut}
            onChange={(e) => setFilterStatut(e.target.value)}
            style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1' }}
          >
            <option value="tous">Tous les statuts</option>
            <option value="complete">Complète</option>
            <option value="partielle">Partielle</option>
            <option value="erreur">Erreur</option>
          </select>
          <span style={{ fontSize: 13, color: '#64748b' }}>{simulationsFiltrees.length} simulation(s)</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <label style={{ marginRight: 8, fontWeight: 600 }}>
                {compareMode ? 'Simulation A :' : 'Simulation :'}
              </label>
              <select
                value={selectedSim?.id || ''}
                onChange={(e) => setSelectedSim(simulations.find((s) => s.id === e.target.value))}
                disabled={simulationsFiltrees.length === 0}
              >
                {simulationsFiltrees.length === 0 ? (
                  <option value="">Aucune simulation</option>
                ) : (
                  simulationsFiltrees.map((sim) => (
                    <option key={sim.id} value={sim.id}>
                      {sim.nom} [{PROFIL_LABELS[sim.profil_type] || 'Générique'}]
                    </option>
                  ))
                )}
              </select>
            </div>

            {compareMode && (
              <div>
                <label style={{ marginRight: 8, fontWeight: 600 }}>Simulation B :</label>
                <select
                  value={selectedSimB?.id || ''}
                  onChange={(e) => setSelectedSimB(simulations.find((s) => s.id === e.target.value))}
                >
                  {simulations.map((sim) => (
                    <option key={sim.id} value={sim.id}>
                      {sim.nom} [{PROFIL_LABELS[sim.profil_type] || 'Générique'}]
                    </option>
                  ))}
                </select>
              </div>
            )}

            {simulations.length > 1 && selectedSim && (
              <button
                onClick={activerDesactiverComparaison}
                style={{ ...btnStyle, backgroundColor: compareMode ? '#7c3aed' : '#475569' }}
              >
                {compareMode ? '✕ Quitter la comparaison' : '⚖️ Comparer 2 simulations'}
              </button>
            )}
          </div>

          {selectedSim && (
            <button
              onClick={exporterPDF}
              disabled={exportingPdf}
              style={{ ...btnStyle, backgroundColor: exportingPdf ? '#64748b' : '#0f766e' }}
            >
              {exportingPdf ? 'Génération du PDF...' : '📄 Exporter le rapport PDF'}
            </button>
          )}
        </div>
      </div>

      {loadingSims && <div className="card">Chargement des simulations...</div>}

      {/* État vide explicite (UI-04) */}
      {!loadingSims && !selectedSim && (
        <div className="card" style={{ textAlign: 'center', padding: 28, color: '#475569' }}>
          <p style={{ margin: '0 0 12px 0', fontSize: 15 }}>
            Aucune simulation ne correspond aux filtres sélectionnés
            {filterProfil !== 'tous' ? ` (profil « ${PROFIL_LABELS[filterProfil]} »)` : ''}.
          </p>
          <button onClick={reinitialiserFiltres} style={btnStyle}>
            Réinitialiser les filtres
          </button>
        </div>
      )}

      {!loadingSims && selectedSim && (
        <>
          {/* En-tête de fiche, métadonnées & validation */}
          {!isComparing && (
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                <span style={badgeStyle('#e0e7ff', '#3730a3')}>
                  Profil : {PROFIL_LABELS[selectedSim.profil_type] || 'Générique'} v{selectedSim.profil_version || '1.0'}
                </span>
                <span style={badgeStyle(statutInfo.bg, statutInfo.color)}>Statut : {statutInfo.label}</span>
                {selectedSim.projet && <span style={badgeStyle('#f1f5f9', '#334155')}>📁 {selectedSim.projet}</span>}
                {(selectedSim.tags || []).map((tag) => (
                  <span key={tag} style={badgeStyle('#f8fafc', '#475569')}>#{tag}</span>
                ))}
              </div>

              {selectedSim.description && <p style={{ margin: '0 0 10px 0', color: '#475569' }}>{selectedSim.description}</p>}

              {metaEntries.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
                  {metaEntries.map(([k, v]) => (
                    <div
                      key={k}
                      style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: '4px 10px', fontSize: 13 }}
                    >
                      <span style={{ color: '#64748b' }}>{k} : </span>
                      <strong>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</strong>
                    </div>
                  ))}
                </div>
              )}

              {selectedSim.validation?.messages?.length > 0 && (
                <div
                  style={{
                    marginTop: 12,
                    padding: '10px 14px',
                    borderRadius: 6,
                    backgroundColor: '#fffbeb',
                    border: '1px solid #fcd34d',
                    color: '#92400e',
                    fontSize: 13,
                  }}
                >
                  <strong>⚠️ Contrôles d&apos;ingestion ({selectedSim.validation.statut}) :</strong>
                  <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                    {selectedSim.validation.messages.map((msg, idx) => (
                      <li key={idx}>{msg}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Barre d'onglets : Aile 2D (Phase 1) */}
          {isAile2D && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              <button onClick={() => setActiveTab('synthese')} style={tabBtnStyle(activeTab === 'synthese')}>
                📊 Synthèse & Convergence
              </button>
              <button onClick={() => setActiveTab('paroi')} style={tabBtnStyle(activeTab === 'paroi')}>
                📈 Répartitions pariétales (Cp, Cf, y+)
              </button>
              <button onClick={() => setActiveTab('polaires')} style={tabBtnStyle(activeTab === 'polaires')}>
                ✈️ Polaires aérodynamiques ({pointsPolaire.length} pt{pointsPolaire.length > 1 ? 's' : ''})
              </button>
            </div>
          )}

          {/* Barre d'onglets : Écoulement interne (Phase 2) */}
          {isInterne && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              <button onClick={() => setActiveTab('synthese')} style={tabBtnStyle(activeTab === 'synthese')}>
                📊 Synthèse & Convergence
              </button>
              <button onClick={() => setActiveTab('interne_bilans')} style={tabBtnStyle(activeTab === 'interne_bilans')}>
                🔧 Bilans, Débits & Sondes
              </button>
              <button onClick={() => setActiveTab('interne_carac')} style={tabBtnStyle(activeTab === 'interne_carac')}>
                📈 Courbe caractéristique ΔP(Q) ({pointsInterne.length} pt{pointsInterne.length > 1 ? 's' : ''})
              </button>
            </div>
          )}

          {/* ONGLET COMMUN : SYNTHÈSE & CONVERGENCE */}
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
                          <th style={thStyle}>{selectedSim.nom} (A)</th>
                          <th style={thStyle}>{selectedSimB.nom} (B)</th>
                          <th style={thStyle}>Écart (B - A)</th>
                          <th style={thStyle}>Écart (%)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {kpiComparatif.map((row) => (
                          <tr key={row.cle}>
                            <td style={{ ...tdStyle, fontWeight: 600 }}>{row.cle}</td>
                            <td style={tdStyle}>
                              {row.kA ? `${row.kA.valeur}${row.kA.unite !== '-' ? ' ' + row.kA.unite : ''}` : '—'}
                            </td>
                            <td style={tdStyle}>
                              {row.kB ? `${row.kB.valeur}${row.kB.unite !== '-' ? ' ' + row.kB.unite : ''}` : '—'}
                            </td>
                            <td style={tdStyle}>
                              {row.delta !== null ? `${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(6)}` : '—'}
                            </td>
                            <td
                              style={{
                                ...tdStyle,
                                fontWeight: 600,
                                color: row.pct === null ? '#64748b' : row.pct >= 0 ? '#0f766e' : '#dc2626',
                              }}
                            >
                              {row.pct !== null ? `${row.pct >= 0 ? '+' : ''}${row.pct.toFixed(2)} %` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="kpi-grid">
                    {Object.entries(selectedSim.kpi_finaux || {}).map(([k, rawVal]) => {
                      const kpi = normaliserKpi(rawVal)
                      const conv = CONV_STYLES[kpi.convergence]
                      const tooltip = `Méthode : ${kpi.methode} | Fenêtre : ${kpi.fenetre} pts | Source : ${kpi.source}${
                        kpi.variation_rel_pct !== null ? ` | Variation : ${kpi.variation_rel_pct}%` : ''
                      }`
                      return (
                        <div key={k} className="kpi-box" title={tooltip}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                            <div className="kpi-label">{k}</div>
                            {conv && <span style={badgeStyle(conv.bg, conv.color)}>{conv.label}</span>}
                          </div>
                          <div className="kpi-value">
                            {kpi.valeur}
                            {kpi.unite && kpi.unite !== '-' && (
                              <span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>{kpi.unite}</span>
                            )}
                          </div>
                          {kpi.ecart_type !== null ? (
                            <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                              σ = ±{kpi.ecart_type} ({kpi.fenetre} pts)
                            </div>
                          ) : (
                            <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{kpi.methode}</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {(tracesA.length > 0 || tracesB.length > 0) && (
                <div className="card">
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: 10,
                      marginBottom: 12,
                    }}
                  >
                    <h2 style={{ margin: 0 }}>
                      {isComparing
                        ? compareLayout === 'superpose'
                          ? 'Courbes de convergence superposées'
                          : 'Courbes de convergence côte à côte'
                        : 'Courbes de convergence'}
                    </h2>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => setYScale((prev) => (prev === 'linear' ? 'log' : 'linear'))}
                        style={{
                          ...btnStyle,
                          backgroundColor: yScale === 'log' ? '#0f766e' : '#e2e8f0',
                          color: yScale === 'log' ? '#fff' : '#1e293b',
                        }}
                      >
                        {yScale === 'log' ? 'Échelle Y : Log' : 'Échelle Y : Linéaire'}
                      </button>

                      {!isComparing && (
                        <button
                          onClick={() => exporterCSV(convergence, selectedSim.nom)}
                          style={{ ...btnStyle, backgroundColor: '#475569' }}
                        >
                          ⬇ CSV
                        </button>
                      )}

                      {isComparing && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            onClick={() => setCompareLayout('superpose')}
                            style={{
                              ...btnStyle,
                              backgroundColor: compareLayout === 'superpose' ? '#7c3aed' : '#e2e8f0',
                              color: compareLayout === 'superpose' ? '#ffffff' : '#1e293b',
                            }}
                          >
                            📈 Superposé
                          </button>
                          <button
                            onClick={() => setCompareLayout('cote_a_cote')}
                            style={{
                              ...btnStyle,
                              backgroundColor: compareLayout === 'cote_a_cote' ? '#7c3aed' : '#e2e8f0',
                              color: compareLayout === 'cote_a_cote' ? '#ffffff' : '#1e293b',
                            }}
                          >
                            📊 Côte à côte
                          </button>
                        </div>
                      )}

                      {(!isComparing || compareLayout === 'superpose') && (
                        <button
                          onClick={() =>
                            telechargerGraphique(
                              plotDivRef,
                              isComparing
                                ? `Comparaison_${selectedSim.nom}_vs_${selectedSimB.nom}`
                                : `${selectedSim.nom}_convergence`
                            )
                          }
                          style={btnStyle}
                        >
                          ⬇ PNG
                        </button>
                      )}
                    </div>
                  </div>

                  {isComparing && compareLayout === 'cote_a_cote' ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
                      <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <strong>A — {selectedSim.nom}</strong>
                          <button
                            onClick={() => telechargerGraphique(plotDivRef, `${selectedSim.nom}_convergence`)}
                            style={{ ...btnStyle, padding: '5px 10px', fontSize: 12 }}
                          >
                            ⬇ PNG
                          </button>
                        </div>
                        <Plot
                          data={tracesA}
                          layout={creerLayoutPlotly(selectedSim.nom, axesA, 420, yScale)}
                          style={{ width: '100%' }}
                          useResizeHandler
                          onInitialized={(_, graphDiv) => {
                            plotDivRef.current = graphDiv
                          }}
                          onUpdate={(_, graphDiv) => {
                            plotDivRef.current = graphDiv
                          }}
                        />
                      </div>

                      <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <strong>B — {selectedSimB.nom}</strong>
                          <button
                            onClick={() => telechargerGraphique(plotDivRefB, `${selectedSimB.nom}_convergence`)}
                            style={{ ...btnStyle, padding: '5px 10px', fontSize: 12 }}
                          >
                            ⬇ PNG
                          </button>
                        </div>
                        <Plot
                          data={tracesB}
                          layout={creerLayoutPlotly(selectedSimB.nom, axesB, 420, yScale)}
                          style={{ width: '100%' }}
                          useResizeHandler
                          onInitialized={(_, graphDiv) => {
                            plotDivRefB.current = graphDiv
                          }}
                          onUpdate={(_, graphDiv) => {
                            plotDivRefB.current = graphDiv
                          }}
                        />
                      </div>
                    </div>
                  ) : (
                    <Plot
                      data={tracesSuperposees}
                      layout={creerLayoutPlotly(
                        isComparing
                          ? `Comparaison : ${selectedSim.nom} vs ${selectedSimB.nom}`
                          : `Courbes de convergence — ${selectedSim.nom}`,
                        axesA,
                        460,
                        yScale
                      )}
                      style={{ width: '100%' }}
                      useResizeHandler
                      onInitialized={(_, graphDiv) => {
                        plotDivRef.current = graphDiv
                      }}
                      onUpdate={(_, graphDiv) => {
                        plotDivRef.current = graphDiv
                      }}
                    />
                  )}
                </div>
              )}

              {isComparing ? (
                (selectedSim.url_visuel_3d || selectedSimB.url_visuel_3d) && (
                  <div className="card">
                    <h2>Visualisation comparée des champs CFD</h2>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
                      {selectedSim.url_visuel_3d && (
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                            <strong>{selectedSim.nom} (A)</strong>
                            <button
                              onClick={() => telechargerImageCFD(selectedSim.url_visuel_3d, selectedSim.nom)}
                              style={{ ...btnStyle, padding: '5px 10px', fontSize: 12 }}
                            >
                              ⬇ PNG
                            </button>
                          </div>
                          <img src={selectedSim.url_visuel_3d} alt={selectedSim.nom} style={{ width: '100%', borderRadius: 8 }} />
                        </div>
                      )}
                      {selectedSimB.url_visuel_3d && (
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                            <strong>{selectedSimB.nom} (B)</strong>
                            <button
                              onClick={() => telechargerImageCFD(selectedSimB.url_visuel_3d, selectedSimB.nom)}
                              style={{ ...btnStyle, padding: '5px 10px', fontSize: 12 }}
                            >
                              ⬇ PNG
                            </button>
                          </div>
                          <img src={selectedSimB.url_visuel_3d} alt={selectedSimB.nom} style={{ width: '100%', borderRadius: 8 }} />
                        </div>
                      )}
                    </div>
                  </div>
                )
              ) : (
                selectedSim.url_visuel_3d && (
                  <div className="card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <h2 style={{ margin: 0 }}>Visualisation du champ CFD</h2>
                      <button
                        onClick={() => telechargerImageCFD(selectedSim.url_visuel_3d, selectedSim.nom)}
                        style={btnStyle}
                      >
                        ⬇ Télécharger l&apos;image CFD (PNG)
                      </button>
                    </div>
                    <img src={selectedSim.url_visuel_3d} alt={selectedSim.nom} style={{ width: '100%', borderRadius: 8 }} />
                  </div>
                )
              )}
            </>
          )}

          {/* ONGLETS AILE 2D (Phase 1) */}
          {isAile2D && activeTab === 'paroi' && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
                <h2 style={{ margin: 0 }}>Répartitions pariétales — {selectedSim.nom}</h2>
                <label style={{ ...btnStyle, backgroundColor: '#475569' }}>
                  📂 Superposer un CSV de référence Cp (Exp. / XFOIL)
                  <input
                    type="file"
                    accept=".csv,.txt,.xy"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      chargerRefCp(e.target.files?.[0])
                      e.target.value = ''
                    }}
                  />
                </label>
              </div>

              {Object.keys(paroi).length === 0 ? (
                <div style={{ padding: 16, backgroundColor: '#f8fafc', borderRadius: 8, color: '#475569' }}>
                  Aucune donnée pariétale (<code>cp.xy</code>, <code>cf.xy</code>, <code>yplus.xy</code>) n&apos;a été trouvée lors de l&apos;ingestion.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  {paroi.cp && (
                    <Plot
                      data={[
                        {
                          x: paroi.cp.x_c,
                          y: paroi.cp.valeur,
                          type: 'scatter',
                          mode: 'markers+lines',
                          name: `CFD (${selectedSim.nom})`,
                          marker: { size: 4 },
                        },
                        ...(refCpData
                          ? [
                              {
                                x: refCpData.x,
                                y: refCpData.y,
                                type: 'scatter',
                                mode: 'markers',
                                name: `Référence (${refCpData.nom})`,
                                marker: { size: 6, symbol: 'circle-open', color: '#dc2626' },
                              },
                            ]
                          : []),
                      ]}
                      layout={{
                        autosize: true,
                        height: 440,
                        title: { text: 'Coefficient de pression Cp(x/c) — Axe inversé', font: { size: 15 } },
                        xaxis: { title: { text: 'x / c' }, showgrid: true, gridcolor: '#e2e8f0' },
                        yaxis: { title: { text: 'Cp' }, autorange: 'reversed', showgrid: true, gridcolor: '#e2e8f0' },
                        showlegend: true,
                        legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.2 },
                        paper_bgcolor: '#ffffff',
                        plot_bgcolor: '#ffffff',
                      }}
                      style={{ width: '100%' }}
                      useResizeHandler
                    />
                  )}
                  {paroi.cf && (
                    <Plot
                      data={[{ x: paroi.cf.x_c, y: paroi.cf.valeur, type: 'scatter', mode: 'lines', name: `Cf (${selectedSim.nom})` }]}
                      layout={{
                        autosize: true,
                        height: 380,
                        title: { text: 'Coefficient de frottement pariétal Cf(x/c)', font: { size: 15 } },
                        xaxis: { title: { text: 'x / c' }, showgrid: true, gridcolor: '#e2e8f0' },
                        yaxis: { title: { text: 'Cf' }, showgrid: true, gridcolor: '#e2e8f0' },
                        paper_bgcolor: '#ffffff',
                        plot_bgcolor: '#ffffff',
                      }}
                      style={{ width: '100%' }}
                      useResizeHandler
                    />
                  )}
                  {paroi.yplus && (
                    <Plot
                      data={[{ x: paroi.yplus.x_c, y: paroi.yplus.valeur, type: 'scatter', mode: 'lines', name: `y+ (${selectedSim.nom})` }]}
                      layout={{
                        autosize: true,
                        height: 380,
                        title: { text: 'Distribution pariétale y+(x/c)', font: { size: 15 } },
                        xaxis: { title: { text: 'x / c' }, showgrid: true, gridcolor: '#e2e8f0' },
                        yaxis: { title: { text: 'y+' }, showgrid: true, gridcolor: '#e2e8f0' },
                        paper_bgcolor: '#ffffff',
                        plot_bgcolor: '#ffffff',
                      }}
                      style={{ width: '100%' }}
                      useResizeHandler
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {isAile2D && activeTab === 'polaires' && (
            <div className="card">
              <h2>Polaires aérodynamiques — {selectedSim.metadonnees?.profil || 'Profil 2D'}</h2>
              {pointsPolaire.filter((p) => p.cl !== null || p.cd !== null).length < 2 ? (
                <div style={{ padding: 16, backgroundColor: '#f8fafc', borderRadius: 8, color: '#475569' }}>
                  Il faut au moins <strong>2 simulations</strong> du même profil (<code>{selectedSim.metadonnees?.profil}</code>) avec <code>Cl</code> et/ou <code>Cd</code> à différents angles <code>alpha</code>.
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 16 }}>
                  <Plot
                    data={[{ x: pointsPolaire.map((p) => p.alpha), y: pointsPolaire.map((p) => p.cl), type: 'scatter', mode: 'lines+markers', name: 'Cl(α)' }]}
                    layout={{ autosize: true, height: 360, title: { text: 'Portance Cl(α)', font: { size: 15 } }, xaxis: { title: { text: 'α (°)' } }, yaxis: { title: { text: 'Cl' } }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff' }}
                    style={{ width: '100%' }}
                    useResizeHandler
                  />
                  <Plot
                    data={[{ x: pointsPolaire.map((p) => p.alpha), y: pointsPolaire.map((p) => p.cd), type: 'scatter', mode: 'lines+markers', name: 'Cd(α)', line: { color: '#dc2626' } }]}
                    layout={{ autosize: true, height: 360, title: { text: 'Traînée Cd(α)', font: { size: 15 } }, xaxis: { title: { text: 'α (°)' } }, yaxis: { title: { text: 'Cd' } }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff' }}
                    style={{ width: '100%' }}
                    useResizeHandler
                  />
                  <Plot
                    data={[{ x: pointsPolaire.map((p) => p.alpha), y: pointsPolaire.map((p) => p.finesse), type: 'scatter', mode: 'lines+markers', name: 'Cl/Cd(α)', line: { color: '#0f766e' } }]}
                    layout={{ autosize: true, height: 360, title: { text: 'Finesse Cl/Cd(α)', font: { size: 15 } }, xaxis: { title: { text: 'α (°)' } }, yaxis: { title: { text: 'Cl / Cd' } }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff' }}
                    style={{ width: '100%' }}
                    useResizeHandler
                  />
                  <Plot
                    data={[{ x: pointsPolaire.map((p) => p.cd), y: pointsPolaire.map((p) => p.cl), text: pointsPolaire.map((p) => `α = ${p.alpha}°`), type: 'scatter', mode: 'lines+markers', name: 'Cl(Cd)', line: { color: '#7c3aed' } }]}
                    layout={{ autosize: true, height: 360, title: { text: 'Polaire de Lilienthal Cl(Cd)', font: { size: 15 } }, xaxis: { title: { text: 'Cd' } }, yaxis: { title: { text: 'Cl' } }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff' }}
                    style={{ width: '100%' }}
                    useResizeHandler
                  />
                </div>
              )}
              {pointsPolaire.length > 0 && (
                <div style={{ overflowX: 'auto', marginTop: 16 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Simulation</th>
                        <th style={thStyle}>α (°)</th>
                        <th style={thStyle}>Cl</th>
                        <th style={thStyle}>Cd</th>
                        <th style={thStyle}>Finesse (Cl/Cd)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pointsPolaire.map((pt) => (
                        <tr key={pt.id}>
                          <td style={{ ...tdStyle, fontWeight: 600 }}>{pt.nom}</td>
                          <td style={tdStyle}>{pt.alpha}</td>
                          <td style={tdStyle}>{pt.cl !== null ? pt.cl.toFixed(5) : '—'}</td>
                          <td style={tdStyle}>{pt.cd !== null ? pt.cd.toFixed(5) : '—'}</td>
                          <td style={tdStyle}>{pt.finesse !== null ? pt.finesse.toFixed(2) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ONGLETS ÉCOULEMENT INTERNE (Phase 2) */}
          {isInterne && activeTab === 'interne_bilans' && (
            <div className="card">
              <h2>Bilans, Répartition des débits & Sondes — {selectedSim.nom}</h2>

              {!repartitionDebits && profilsAxiauxInterne.length === 0 ? (
                <div style={{ padding: 16, backgroundColor: '#f8fafc', borderRadius: 8, color: '#475569' }}>
                  Aucune répartition multi-sorties ni fichier de sonde (<code>axe.xy</code>, <code>sonde.xy</code>) trouvé pour ce cas.
                  <br />
                  <strong>Astuce :</strong> nomme tes colonnes de débits avec <code>m_in</code> / <code>m_out_1</code> / <code>m_out_2</code> dans Fluent pour activer automatiquement le bilan de masse et le graphique en barres.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  {repartitionDebits && (
                    <Plot
                      data={[
                        {
                          x: Object.keys(repartitionDebits),
                          y: Object.values(repartitionDebits),
                          type: 'bar',
                          text: Object.values(repartitionDebits).map((v) => `${v}%`),
                          textposition: 'auto',
                          marker: { color: '#2563eb' },
                        },
                      ]}
                      layout={{
                        autosize: true,
                        height: 380,
                        title: { text: 'Répartition du débit par sortie (%)', font: { size: 15 } },
                        xaxis: { title: { text: 'Sortie' } },
                        yaxis: { title: { text: 'Part du débit (%)' }, range: [0, 105] },
                        paper_bgcolor: '#ffffff',
                        plot_bgcolor: '#ffffff',
                      }}
                      style={{ width: '100%' }}
                      useResizeHandler
                    />
                  )}

                  {profilsAxiauxInterne.map(([nomProfil, data]) => (
                    <Plot
                      key={nomProfil}
                      data={[{ x: data.x_c, y: data.valeur, type: 'scatter', mode: 'lines', name: nomProfil }]}
                      layout={{
                        autosize: true,
                        height: 380,
                        title: { text: `Profil extrait : ${nomProfil} (${data.source})`, font: { size: 15 } },
                        xaxis: { title: { text: 'Position (m)' }, showgrid: true, gridcolor: '#e2e8f0' },
                        yaxis: { title: { text: nomProfil }, showgrid: true, gridcolor: '#e2e8f0' },
                        paper_bgcolor: '#ffffff',
                        plot_bgcolor: '#ffffff',
                      }}
                      style={{ width: '100%' }}
                      useResizeHandler
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {isInterne && activeTab === 'interne_carac' && (
            <div className="card">
              <h2>Courbe caractéristique — Projet « {selectedSim.projet || 'Défaut'} »</h2>

              {pointsInterne.filter((p) => p.debit !== null && (p.dpTot !== null || p.dpStat !== null)).length < 2 ? (
                <div style={{ padding: 16, backgroundColor: '#f8fafc', borderRadius: 8, color: '#475569' }}>
                  Il faut au moins <strong>2 simulations</strong> de type <code>Écoulement interne</code> dans le même projet avec un débit et une perte de charge (<code>ΔP totale</code> ou <code>ΔP statique</code>) pour tracer la courbe caractéristique ΔP(Q).
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 16 }}>
                  <Plot
                    data={[
                      {
                        x: pointsInterne.map((p) => p.debit),
                        y: pointsInterne.map((p) => p.dpTot ?? p.dpStat),
                        type: 'scatter',
                        mode: 'lines+markers',
                        name: 'ΔP(Q)',
                        line: { color: '#2563eb' },
                      },
                    ]}
                    layout={{
                      autosize: true,
                      height: 380,
                      title: { text: 'Perte de charge ΔP en fonction du débit', font: { size: 15 } },
                      xaxis: { title: { text: 'Débit massique Q (kg/s)' }, showgrid: true, gridcolor: '#e2e8f0' },
                      yaxis: { title: { text: 'ΔP (Pa)' }, showgrid: true, gridcolor: '#e2e8f0' },
                      paper_bgcolor: '#ffffff',
                      plot_bgcolor: '#ffffff',
                    }}
                    style={{ width: '100%' }}
                    useResizeHandler
                  />

                  <Plot
                    data={[
                      {
                        x: pointsInterne.map((p) => p.re),
                        y: pointsInterne.map((p) => p.kPerte),
                        type: 'scatter',
                        mode: 'lines+markers',
                        name: 'K(Re)',
                        line: { color: '#0f766e' },
                      },
                    ]}
                    layout={{
                      autosize: true,
                      height: 380,
                      title: { text: 'Coefficient de perte K en fonction de Re', font: { size: 15 } },
                      xaxis: { title: { text: 'Nombre de Reynolds Re' }, showgrid: true, gridcolor: '#e2e8f0' },
                      yaxis: { title: { text: 'K (-)' }, showgrid: true, gridcolor: '#e2e8f0' },
                      paper_bgcolor: '#ffffff',
                      plot_bgcolor: '#ffffff',
                    }}
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
                        <th style={thStyle}>Re</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pointsInterne.map((pt) => (
                        <tr key={pt.id}>
                          <td style={{ ...tdStyle, fontWeight: 600 }}>{pt.nom}</td>
                          <td style={tdStyle}>{pt.debit !== null ? pt.debit : '—'}</td>
                          <td style={tdStyle}>{pt.dpStat !== null ? pt.dpStat : '—'}</td>
                          <td style={tdStyle}>{pt.dpTot !== null ? pt.dpTot : '—'}</td>
                          <td style={tdStyle}>{pt.kPerte !== null ? pt.kPerte : '—'}</td>
                          <td style={tdStyle}>{pt.re !== null ? pt.re : '—'}</td>
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