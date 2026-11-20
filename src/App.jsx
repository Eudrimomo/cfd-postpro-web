import { useEffect, useState } from 'react'
import Plot from 'react-plotly.js'
import { supabase } from './lib/supabase'

export default function App() {
  const [simulations, setSimulations] = useState([])
  const [selectedSim, setSelectedSim] = useState(null)
  const [convergence, setConvergence] = useState([])

  useEffect(() => {
    async function chargerSimulations() {
      const { data, error } = await supabase
        .from('simulations')
        .select('*')
        .order('created_at', { ascending: false })

      if (!error && data && data.length > 0) {
        setSimulations(data)
        setSelectedSim(data[0])
      }
    }
    chargerSimulations()
  }, [])

  useEffect(() => {
    if (!selectedSim) return
    async function chargerConvergence() {
      const { data } = await supabase
        .from('convergence_data')
        .select('donnees')
        .eq('simulation_id', selectedSim.id)
        .single()

      if (data && data.donnees) {
        setConvergence(data.donnees)
      } else {
        setConvergence([])
      }
    }
    chargerConvergence()
  }, [selectedSim])

  const clesCourbes = convergence.length > 0 ? Object.keys(convergence[0]) : []
  const hasFlowTime = clesCourbes.includes('flow-time')
  const axeX = hasFlowTime ? 'flow-time' : clesCourbes[0]
  const variablesY = clesCourbes.filter(
    (cle) => cle !== axeX && cle !== clesCourbes[0]
  )

  return (
    <div className="container">
      <h1>Post-Traitement CFD — ANSYS Fluent</h1>

      <div className="card">
        <label style={{ marginRight: 12, fontWeight: 600 }}>Simulation :</label>
        <select
          value={selectedSim?.id || ''}
          onChange={(e) => setSelectedSim(simulations.find((s) => s.id === e.target.value))}
        >
          {simulations.map((sim) => (
            <option key={sim.id} value={sim.id}>
              {sim.nom}
            </option>
          ))}
        </select>
      </div>

      {selectedSim && (
        <>
          <div className="card">
            <h2>KPI Moyennés (Fin de calcul)</h2>
            <div className="kpi-grid">
              {Object.entries(selectedSim.kpi_finaux || {}).map(([k, v]) => (
                <div key={k} className="kpi-box">
                  <div className="kpi-label">{k}</div>
                  <div className="kpi-value">{v}</div>
                </div>
              ))}
            </div>
          </div>

          {convergence.length > 0 && (
            <div className="card">
              <h2>Courbes de convergence</h2>
              <Plot
                data={variablesY.map((varY) => ({
                  x: convergence.map((row) => row[axeX]),
                  y: convergence.map((row) => row[varY]),
                  type: 'scatter',
                  mode: 'lines',
                  name: varY,
                }))}
                layout={{
                  autosize: true,
                  height: 420,
                  xaxis: { title: hasFlowTime ? 'Flow Time (s)' : axeX },
                  yaxis: { title: 'Valeur' },
                  margin: { t: 20, r: 20, l: 55, b: 50 },
                }}
                style={{ width: '100%' }}
                useResizeHandler
              />
            </div>
          )}

          {selectedSim.url_visuel_3d && (
            <div className="card">
              <h2>Visualisation du champ CFD</h2>
              <img
                src={selectedSim.url_visuel_3d}
                alt={selectedSim.nom}
                style={{ width: '100%', borderRadius: 8 }}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
