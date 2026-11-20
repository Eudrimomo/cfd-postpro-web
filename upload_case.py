import argparse
import hashlib
import json
import math
import os
import re
from pathlib import Path
import numpy as np
import pandas as pd
import pyvista as pv
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Erreur : Configurez SUPABASE_URL et SUPABASE_KEY dans le fichier .env")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

SCRIPT_VERSION = "2.5"
EXTENSIONS_COURBES = (".out", ".csv", ".txt", ".xy")
EXTENSIONS_MAILLAGES = (".case", ".vtu", ".vtk", ".vtp", ".cgns", ".stl")
MOTS_CLES_PROFILS = ("cp", "cf", "yplus", "y+", "axe", "sonde")
COLONNES_ABSCISSE = ("flow-time", "flow_time", "time", "temps", "iteration", "iter", "step", "time step", "time-step")
CONDITIONS_IMPOSEES_DEFAUT = ("p_out", "p_sortie", "m_in", "mdot_in", "debit_entree", "v_in", "t_in")

SEVERITE_STATUT = {
    None: 0,
    "imposee": 0,
    "converge": 1,
    "limite": 2,
    "oscillant": 3,
    "constante": 4,
    "indetermine": 5,
    "non_converge": 6,
    "instabilite": 7,
}

PROFILS_CONFIG = {
    "generique": {
        "version": "1.2",
        "meta_requises": [],
        "cmap": "viridis",
    },
    "aile_2d": {
        "version": "1.3",
        "meta_requises": [
            "profil",
            "corde",
            "vitesse_amont",
            "rho",
            "alpha",
            "turbulence",
            "nb_cellules",
        ],
        "cmap": "viridis",
    },
    "interne": {
        "version": "1.3",
        "meta_requises": [
            "fluide",
            "regime",
            "condition_entree",
            "condition_sortie",
            "diametre_hydraulique",
            "turbulence",
            "nb_cellules",
        ],
        "cmap": "viridis",
    },
}


def pire_statut(statuts: list[str | None]) -> str | None:
    valides = [s for s in statuts if s is not None]
    if not valides:
        return None
    return max(valides, key=lambda s: SEVERITE_STATUT.get(s, 0))


def calculer_sha256(filepath: Path) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def est_ligne_numerique(ligne: str) -> bool:
    tokens = [t for t in re.split(r"[\s,;]+", ligne.strip()) if t]
    if len(tokens) < 2:
        return False
    try:
        for t in tokens:
            float(t)
        return True
    except ValueError:
        return False


def lire_donnees_fluent(filepath: Path) -> tuple[pd.DataFrame, list[str]]:
    alertes = []
    with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
        lignes = f.readlines()

    debut_donnees = None
    for i, ligne in enumerate(lignes):
        if est_ligne_numerique(ligne):
            debut_donnees = i
            break

    if debut_donnees is None:
        raise ValueError(f"Aucune donnée numérique trouvée dans {filepath.name}")

    colonnes = None
    for ligne in reversed(lignes[:debut_donnees]):
        l_strip = ligne.strip()
        if not l_strip:
            continue
        if l_strip.startswith("(") and l_strip.endswith(")"):
            colonnes = re.findall(r'"([^"]+)"', l_strip)
            if colonnes:
                break
        l_clean = l_strip.lstrip("#%").strip()
        if l_clean and not l_clean.startswith('"Report'):
            candidats = [
                c.strip().strip('"').strip("'")
                for c in re.split(r"[\t,;]+|\s{2,}", l_clean)
                if c.strip()
            ]
            if len(candidats) >= 2:
                colonnes = candidats
                break

    ligne_ref = lignes[debut_donnees].strip()
    if "," in ligne_ref:
        sep = ","
    elif ";" in ligne_ref:
        sep = ";"
    else:
        sep = r"\s+"

    df = pd.read_csv(filepath, sep=sep, skiprows=debut_donnees, header=None, engine="python")
    df = df.dropna(axis=1, how="all")
    df = df.apply(pd.to_numeric, errors="coerce")

    nb_nan = int(df.isna().sum().sum())
    nb_inf = int(np.isinf(df.select_dtypes(include=[np.number]).to_numpy()).sum())
    if nb_nan > 0:
        alertes.append(f"{filepath.name} : {nb_nan} valeur(s) NaN détectée(s) et écartée(s).")
    if nb_inf > 0:
        alertes.append(f"{filepath.name} : {nb_inf} valeur(s) infinie(s) détectée(s) et écartée(s).")

    df = df.replace([np.inf, -np.inf], np.nan).dropna(how="any").reset_index(drop=True)

    if colonnes and len(colonnes) == df.shape[1]:
        df.columns = colonnes
    else:
        df.columns = [f"Col_{i}" for i in range(df.shape[1])]

    return df, alertes


def detecter_colonne_x(df: pd.DataFrame) -> tuple[str, str]:
    for col in df.columns:
        cl = col.lower().strip()
        if any(k in cl for k in ("flow-time", "flow_time", "time", "temps")) and "step" not in cl:
            return col, "transitoire"
    for col in df.columns:
        cl = col.lower().strip()
        if "time step" in cl or "time-step" in cl:
            return col, "transitoire"
    for col in df.columns:
        cl = col.lower().strip()
        if any(k in cl for k in ("iter", "step")):
            return col, "stationnaire"
    return df.columns[0], "stationnaire"


def deduire_unite(nom_col: str) -> str:
    c = nom_col.lower()
    if any(k in c for k in ("cl", "cd", "cm", "cp", "cf", "yplus", "y+", "mach", "reynolds", "finesse")):
        return "-"
    if "pressure" in c or "pression" in c or "dp" in c or c.startswith(("p_", "p0_")):
        return "Pa"
    if "velocity" in c or "vitesse" in c:
        return "m/s"
    if "mass-flow" in c or "debit" in c or "mdot" in c or "m_in" in c or "m_out" in c:
        return "kg/s"
    if "temp" in c or c.startswith("t_"):
        return "K"
    if "force" in c or "drag" in c or "lift" in c:
        return "N"
    if "moment" in c:
        return "N·m"
    if "time" in c:
        return "s"
    return "-"


def analyser_fft_signal(valeurs: np.ndarray, dt: float | None) -> tuple[float | None, float | None, float | None]:
    if dt is None or dt <= 0 or len(valeurs) < 32:
        return None, None, None

    centree = valeurs - np.mean(valeurs)
    if np.std(centree) < 1e-12:
        return None, None, None

    freqs = np.fft.rfftfreq(len(centree), d=dt)
    spectre = np.abs(np.fft.rfft(centree))
    spectre[0] = 0.0
    idx_pic = int(np.argmax(spectre))
    freq_dom = float(freqs[idx_pic])
    if freq_dom <= 0:
        return None, None, None

    duree = len(valeurs) * dt
    nb_periodes = duree * freq_dom
    moy_periodes = None
    if nb_periodes >= 2.0:
        n_entier = int(round(math.floor(nb_periodes) / (freq_dom * dt)))
        if 10 <= n_entier <= len(valeurs):
            moy_periodes = float(np.mean(valeurs[-n_entier:]))

    return round(freq_dom, 4), round(nb_periodes, 2), (round(moy_periodes, 6) if moy_periodes is not None else None)


def calculer_kpi_enrichis(
    df: pd.DataFrame,
    source_name: str,
    col_x: str,
    regime: str,
    metadonnees: dict,
    conditions_imposees: list[str] | None = None,
    fenetre: int = 100,
    seuil_conv_pct: float = 0.1,
    min_points_conv: int = 20,
) -> tuple[dict, list[str]]:
    kpi_finaux = {}
    alertes = []
    imposees_set = {c.lower() for c in (conditions_imposees or [])} | set(CONDITIONS_IMPOSEES_DEFAUT)

    dt = metadonnees.get("dt")
    if dt is not None:
        dt = float(dt)
    elif regime == "transitoire" and "time" in col_x.lower() and "step" not in col_x.lower() and len(df) >= 2:
        diffs = np.diff(df[col_x].to_numpy(dtype=float))
        diffs_pos = diffs[diffs > 0]
        if len(diffs_pos) > 0:
            dt = float(np.median(diffs_pos))
            metadonnees["dt"] = round(dt, 8)
    elif regime == "transitoire":
        alertes.append(
            "Régime transitoire sans pas de temps Δt : renseignez 'dt' (en s) dans les métadonnées pour calculer la fréquence et le nombre de Strouhal."
        )

    cols_kpi = [
        c for c in df.columns
        if c != col_x and c.lower().strip() not in COLONNES_ABSCISSE
    ]

    for col in cols_kpi:
        serie = df[col].dropna()
        if serie.empty:
            continue

        n_total = len(serie)
        n_win = min(fenetre, n_total)
        tail = serie.tail(n_win)
        tail_np = tail.to_numpy(dtype=float)

        moyenne = float(tail.mean())
        ecart_type = float(tail.std(ddof=0))
        rms = float(np.sqrt(np.mean(np.square(tail_np))))
        etendue_win = float(tail.max() - tail.min())
        amplitude = etendue_win / 2.0
        etendue_tot = float(serie.max() - serie.min())

        var_rel_pct = None
        freq_hz, nb_periodes, moy_periodes = None, None, None
        moyenne_significative = True
        est_imposee = col.lower() in imposees_set

        if etendue_tot == 0.0:
            if est_imposee:
                etat_conv = "imposee"
            else:
                etat_conv = "constante"
                alertes.append(f"Variable '{col}' strictement constante ({moyenne:.6g}) sur toute la série.")
            var_rel_pct = 0.0
        elif n_total < min_points_conv:
            etat_conv = "indetermine"
        else:
            moitie = n_win // 2
            std_1 = float(tail.iloc[:moitie].std(ddof=0)) if moitie >= 5 else 0.0
            std_2 = float(tail.iloc[moitie:].std(ddof=0)) if moitie >= 5 else 0.0
            croissance = std_1 > 1e-9 and (std_2 / std_1) > 1.5 and etendue_win > 1e-4

            echelle_ref = max(abs(moyenne), etendue_tot, 1e-6)
            var_rel_raw = (etendue_win / echelle_ref) * 100.0

            if regime == "transitoire":
                freq_hz, nb_periodes, moy_periodes = analyser_fft_signal(tail_np, dt)

            if regime == "transitoire" and croissance:
                etat_conv = "instabilite"
                moyenne_significative = False
                alertes.append(
                    f"Amplitude croissante sur '{col}' (±{amplitude:.4g} sur {n_win} pts) : vérifier la phase de démarrage, le pas de temps et le nombre de Courant."
                )
            elif abs(moyenne) < 0.05 * etendue_tot and etendue_tot > 1e-4:
                etat_conv = "oscillant"
                if moy_periodes is not None:
                    moyenne = moy_periodes
                    moyenne_significative = True
                else:
                    moyenne_significative = False
            else:
                var_rel_pct = round(min(var_rel_raw, 100.0), 4)
                if var_rel_pct <= seuil_conv_pct:
                    etat_conv = "converge"
                elif var_rel_pct <= seuil_conv_pct * 10:
                    etat_conv = "limite"
                else:
                    etat_conv = "non_converge"
                    alertes.append(
                        f"Convergence incertaine pour '{col}' : variation de {var_rel_pct:.2f}% sur les {n_win} derniers points."
                    )

        strouhal = None
        if freq_hz and metadonnees.get("corde") and metadonnees.get("vitesse_amont"):
            v_inf = float(metadonnees["vitesse_amont"])
            if v_inf > 0:
                strouhal = round(freq_hz * float(metadonnees["corde"]) / v_inf, 4)

        kpi_finaux[col] = {
            "valeur": round(moyenne, 6),
            "moyenne_significative": moyenne_significative,
            "ecart_type": round(ecart_type, 6),
            "rms": round(rms, 6),
            "amplitude": round(amplitude, 6),
            "frequence_hz": freq_hz,
            "nb_periodes": nb_periodes,
            "strouhal": strouhal,
            "variation_rel_pct": var_rel_pct,
            "unite": deduire_unite(col),
            "methode": "moyenne_periodes_entieres" if (moy_periodes is not None) else "moyenne_finale",
            "fenetre": int(n_win),
            "convergence": etat_conv,
            "source": f"{source_name}:{col}",
        }

    return kpi_finaux, alertes


def traiter_profil_aile_2d(
    dossier: Path,
    metadonnees: dict,
    kpi_finaux: dict,
    empreintes: dict,
) -> tuple[dict, list[str]]:
    profils_paroi = {}
    alertes = []

    corde = float(metadonnees.get("corde") or 1.0)
    v_inf = metadonnees.get("vitesse_amont")
    rho = metadonnees.get("rho")
    mu = metadonnees.get("mu")
    alpha = metadonnees.get("alpha")
    turbulence = str(metadonnees.get("turbulence", "")).lower()
    nom_profil = str(metadonnees.get("profil", "")).upper()

    if v_inf and rho and mu and float(mu) > 0:
        re_val = float(rho) * float(v_inf) * corde / float(mu)
        kpi_finaux["Reynolds"] = {
            "valeur": round(re_val, 1),
            "ecart_type": None,
            "variation_rel_pct": None,
            "unite": "-",
            "methode": "calculé (ρ·V∞·c / μ)",
            "fenetre": 0,
            "convergence": "imposee",
            "source": "metadata.json",
        }

    if v_inf:
        temp_fournie = metadonnees.get("temperature") is not None
        temp_k = float(metadonnees.get("temperature") or 288.15)
        a_son = math.sqrt(1.4 * 287.05 * temp_k)
        mach_val = float(v_inf) / a_son
        kpi_finaux["Mach"] = {
            "valeur": round(mach_val, 4),
            "ecart_type": None,
            "variation_rel_pct": None,
            "unite": "-",
            "methode": f"calculé (T = {temp_k} K)" if temp_fournie else "calculé (hypothèse T = 288,15 K)",
            "hypothese": not temp_fournie,
            "fenetre": 0,
            "convergence": "imposee",
            "source": "metadata.json",
        }

    cl_key = next((k for k in kpi_finaux if k.lower() in ("cl", "cl-1", "lift-coeff", "portance")), None)
    cd_key = next((k for k in kpi_finaux if k.lower() in ("cd", "cd-1", "drag-coeff", "trainee")), None)

    if cl_key and cd_key:
        cl_val = kpi_finaux[cl_key]["valeur"]
        cd_val = kpi_finaux[cd_key]["valeur"]
        if abs(cd_val) > 1e-12:
            statut_finesse = pire_statut([kpi_finaux[cl_key].get("convergence"), kpi_finaux[cd_key].get("convergence")])
            fen_min = min(kpi_finaux[cl_key].get("fenetre", 0), kpi_finaux[cd_key].get("fenetre", 0))
            kpi_finaux["Finesse (Cl/Cd)"] = {
                "valeur": round(cl_val / cd_val, 3),
                "ecart_type": None,
                "variation_rel_pct": None,
                "unite": "-",
                "methode": "ratio Cl / Cd",
                "fenetre": fen_min,
                "convergence": statut_finesse,
                "source": f"{cl_key}/{cd_key}",
            }

    if cl_key and alpha is not None:
        cl_val = kpi_finaux[cl_key]["valeur"]
        alpha_deg = float(alpha)
        if alpha_deg == 0.0 and "00" in nom_profil and abs(cl_val) > 0.05:
            alertes.append(
                f"À vérifier : profil symétrique ({nom_profil}) à α=0° mais Cl={cl_val:.4f} (attendu ≈ 0)."
            )
        elif abs(alpha_deg) <= 10.0 and "00" in nom_profil:
            cl_theo = 2.0 * math.pi * math.radians(alpha_deg)
            if abs(cl_val - cl_theo) > max(0.35, 0.6 * abs(cl_theo)):
                alertes.append(
                    f"À vérifier : Cl={cl_val:.4f} à α={alpha_deg}° s'écarte fortement de l'ordre de grandeur théorique (≈ {cl_theo:.2f})."
                )

    if cd_key:
        cd_val = kpi_finaux[cd_key]["valeur"]
        if cd_val <= 0 or cd_val > 5.0:
            alertes.append(f"À vérifier : Cd={cd_val:.4f} hors plage physique usuelle.")

    if not cl_key and not cd_key:
        alertes.append(
            "Colonnes Cl / Cd non reconnues pour le profil Aile 2D : associez-les depuis l'interface ou via 'mapping_colonnes'."
        )

    taille_dom = metadonnees.get("taille_domaine_cordes")
    if taille_dom is not None and float(taille_dom) < 20:
        alertes.append(
            f"Domaine fluide restreint ({taille_dom} cordes < 20 cordes recommandées pour un profil 2D)."
        )

    for fpath in sorted(dossier.iterdir()):
        if not fpath.is_file() or fpath.suffix.lower() not in (".xy", ".csv", ".txt"):
            continue
        nom_low = fpath.stem.lower()
        type_paroi = None
        if "cp" in nom_low:
            type_paroi = "cp"
        elif "cf" in nom_low:
            type_paroi = "cf"
        elif "yplus" in nom_low or "y+" in nom_low:
            type_paroi = "yplus"

        if not type_paroi:
            continue

        try:
            df_p, alertes_p = lire_donnees_fluent(fpath)
            alertes.extend(alertes_p)
            empreintes[fpath.name] = calculer_sha256(fpath)

            x_vals = df_p.iloc[:, 0].to_numpy(dtype=float)
            y_vals = df_p.iloc[:, 1].to_numpy(dtype=float)
            if corde > 0 and abs(np.max(x_vals) - corde) < 0.1 * corde:
                x_norm = x_vals / corde
            else:
                x_norm = x_vals

            if len(x_norm) > 500:
                idx = np.linspace(0, len(x_norm) - 1, 500, dtype=int)
                x_store, y_store = x_norm[idx], y_vals[idx]
            else:
                x_store, y_store = x_norm, y_vals

            profils_paroi[type_paroi] = {
                "source": fpath.name,
                "x_c": [round(float(v), 5) for v in x_store],
                "valeur": [round(float(v), 6) for v in y_store],
            }
            print(f"[OK] Profil pariétal '{type_paroi}' extrait : {fpath.name} ({len(x_vals)} pts)")

            if type_paroi == "cp":
                idx_min = int(np.argmin(y_vals))
                cp_min = float(y_vals[idx_min])
                cp_max = float(np.max(y_vals))
                kpi_finaux["Cp_min"] = {
                    "valeur": round(cp_min, 4),
                    "ecart_type": None,
                    "variation_rel_pct": None,
                    "unite": "-",
                    "methode": f"min à x/c = {x_norm[idx_min]:.3f}",
                    "fenetre": len(y_vals),
                    "convergence": None,
                    "source": fpath.name,
                }
                if abs(cp_max - 1.0) > 0.15:
                    alertes.append(
                        f"À vérifier : Cp maximal = {cp_max:.3f} (attendu proche de 1,0 au point d'arrêt)."
                    )

            elif type_paroi == "yplus":
                yp_mean = float(np.mean(y_vals))
                yp_max = float(np.max(y_vals))
                if "omega" in turbulence or "sst" in turbulence or "spalart" in turbulence or "lam" in turbulence:
                    hors_plage = np.sum(y_vals > 5.0) / len(y_vals) * 100.0
                    plage_txt = "y+ <= 5 (sous-couche résolue)"
                else:
                    hors_plage = np.sum((y_vals < 30.0) | (y_vals > 300.0)) / len(y_vals) * 100.0
                    plage_txt = "30 <= y+ <= 300 (lois de paroi)"

                kpi_finaux["y+ moyen"] = {
                    "valeur": round(yp_mean, 3),
                    "ecart_type": round(float(np.std(y_vals)), 3),
                    "variation_rel_pct": None,
                    "unite": "-",
                    "methode": f"max = {yp_max:.2f}, hors plage = {hors_plage:.1f}%",
                    "fenetre": len(y_vals),
                    "convergence": "converge" if hors_plage <= 5.0 else "non_converge",
                    "source": fpath.name,
                }
                if hors_plage > 5.0:
                    alertes.append(
                        f"Qualité y+ : {hors_plage:.1f}% des points sont hors plage ({plage_txt})."
                    )

        except Exception as e:
            alertes.append(f"Impossible de lire le profil pariétal {fpath.name} ({e}).")

    return profils_paroi, alertes


def traiter_profil_interne(
    dossier: Path,
    metadonnees: dict,
    kpi_finaux: dict,
    empreintes: dict,
) -> tuple[dict, list[str]]:
    profils_extraits = {}
    alertes = []

    rho = metadonnees.get("rho")
    mu = metadonnees.get("mu")
    dh = metadonnees.get("diametre_hydraulique")
    v_ref = metadonnees.get("vitesse_ref") or metadonnees.get("vitesse_entree")
    composant = str(metadonnees.get("composant", "conduite")).lower()

    if rho and mu and dh and v_ref and float(mu) > 0:
        re_val = float(rho) * float(v_ref) * float(dh) / float(mu)
        kpi_finaux["Reynolds"] = {
            "valeur": round(re_val, 1),
            "ecart_type": None,
            "variation_rel_pct": None,
            "unite": "-",
            "methode": "calculé (ρ·V_réf·Dh / μ)",
            "fenetre": 0,
            "convergence": "imposee",
            "source": "metadata.json",
        }

    def chercher_kpi_obj(mots_cles: tuple[str, ...]) -> tuple[str | None, dict | None]:
        for k, v in kpi_finaux.items():
            kl = k.lower()
            if any(m in kl for m in mots_cles):
                return k, v
        return None, None

    _, p_in_obj = chercher_kpi_obj(("p_in", "p_entree", "p_stat_in", "static-pressure-in"))
    _, p_out_obj = chercher_kpi_obj(("p_out", "p_sortie", "p_stat_out", "static-pressure-out"))
    _, p0_in_obj = chercher_kpi_obj(("p0_in", "ptot_in", "p_tot_in", "total-pressure-in"))
    _, p0_out_obj = chercher_kpi_obj(("p0_out", "ptot_out", "p_tot_out", "total-pressure-out"))

    q_dyn = 0.5 * float(rho) * (float(v_ref) ** 2) if (rho and v_ref and float(v_ref) > 0) else None

    if p_in_obj and p_out_obj:
        dp_stat = float(p_in_obj["valeur"]) - float(p_out_obj["valeur"])
        stat_p = pire_statut([p_in_obj.get("convergence"), p_out_obj.get("convergence")])
        fen_p = min(p_in_obj.get("fenetre", 0), p_out_obj.get("fenetre", 0))
        kpi_finaux["ΔP statique"] = {
            "valeur": round(dp_stat, 4),
            "ecart_type": None,
            "variation_rel_pct": None,
            "unite": "Pa",
            "methode": "p_entrée − p_sortie",
            "fenetre": fen_p,
            "convergence": stat_p,
            "source": "calculé",
        }
        if composant == "diffuseur" and q_dyn and q_dyn > 1e-12:
            cpr = (float(p_out_obj["valeur"]) - float(p_in_obj["valeur"])) / q_dyn
            kpi_finaux["Cp,r (récupération)"] = {
                "valeur": round(cpr, 4),
                "ecart_type": None,
                "variation_rel_pct": None,
                "unite": "-",
                "methode": "(p_sortie − p_entrée) / (½·ρ·V²)",
                "fenetre": fen_p,
                "convergence": stat_p,
                "source": "calculé",
            }

    if p0_in_obj and p0_out_obj:
        p0_in_val = float(p0_in_obj["valeur"])
        p0_out_val = float(p0_out_obj["valeur"])
        dp_tot = p0_in_val - p0_out_val
        stat_p0 = pire_statut([p0_in_obj.get("convergence"), p0_out_obj.get("convergence")])
        fen_p0 = min(p0_in_obj.get("fenetre", 0), p0_out_obj.get("fenetre", 0))

        kpi_finaux["ΔP totale"] = {
            "valeur": round(dp_tot, 4),
            "ecart_type": None,
            "variation_rel_pct": None,
            "unite": "Pa",
            "methode": "P0_entrée − P0_sortie",
            "fenetre": fen_p0,
            "convergence": stat_p0,
            "source": "calculé",
        }
        profils_extraits["pression_cascade"] = {
            "p0_entree": round(p0_in_val, 3),
            "dp_totale": round(dp_tot, 3),
            "p0_sortie": round(p0_out_val, 3),
        }

        if q_dyn and q_dyn > 1e-12:
            k_perte = dp_tot / q_dyn
            kpi_finaux["Coefficient perte K"] = {
                "valeur": round(k_perte, 4),
                "ecart_type": None,
                "variation_rel_pct": None,
                "unite": "-",
                "methode": "ΔP_totale / (½·ρ·V_réf²)",
                "fenetre": fen_p0,
                "convergence": stat_p0,
                "source": "calculé",
            }
            if k_perte < 0 or k_perte > 50:
                alertes.append(f"À vérifier : coefficient de perte K={k_perte:.3f} hors plage usuelle (0 <= K <= 50).")

    debits_entrees = {}
    debits_sorties = {}
    statuts_debits = []
    fenetres_debits = []

    for k, v in list(kpi_finaux.items()):
        kl = k.lower()
        if any(m in kl for m in ("mdot", "debit", "mass-flow", "m_in", "m_out")):
            val = abs(float(v["valeur"]))
            if any(e in kl for e in ("in", "entree", "inlet")):
                debits_entrees[k] = val
                statuts_debits.append(v.get("convergence"))
                fenetres_debits.append(v.get("fenetre", 0))
            elif any(s in kl for s in ("out", "sortie", "outlet")):
                debits_sorties[k] = val
                statuts_debits.append(v.get("convergence"))
                fenetres_debits.append(v.get("fenetre", 0))

    if debits_entrees and debits_sorties:
        m_in_tot = sum(debits_entrees.values())
        m_out_tot = sum(debits_sorties.values())
        ecart_abs = abs(m_in_tot - m_out_tot)
        if m_in_tot > 1e-12:
            ecart_masse_pct = ecart_abs / m_in_tot * 100.0
            stat_valeur = "converge" if ecart_masse_pct <= 0.1 else ("limite" if ecart_masse_pct <= 1.0 else "non_converge")
            stat_final = pire_statut([stat_valeur] + statuts_debits)
            fen_min = min(fenetres_debits) if fenetres_debits else 0

            kpi_finaux["Bilan de masse (%)"] = {
                "valeur": round(ecart_masse_pct, 4),
                "ecart_type": None,
                "variation_rel_pct": None,
                "unite": "%",
                "methode": "|m_entrées − m_sorties| / m_entrées",
                "fenetre": fen_min,
                "convergence": stat_final,
                "source": "calculé",
            }
            if ecart_masse_pct > 0.1:
                alertes.append(
                    f"Bilan de masse hors tolérance : écart relatif de {ecart_masse_pct:.3f}% (> 0,1%)."
                )

            profils_extraits["bilan_masse"] = {
                "entrees": debits_entrees,
                "sorties": debits_sorties,
                "total_entrees": round(m_in_tot, 6),
                "total_sorties": round(m_out_tot, 6),
                "ecart_absolu": round(ecart_abs, 6),
                "ecart_relatif_pct": round(ecart_masse_pct, 4),
            }

        if m_out_tot > 1e-12:
            repartition = {
                nom: round(val / m_out_tot * 100.0, 2)
                for nom, val in debits_sorties.items()
            }
            profils_extraits["repartition_debits"] = repartition

    _, t_in_obj = chercher_kpi_obj(("t_in", "t_entree", "temp_in"))
    _, t_out_obj = chercher_kpi_obj(("t_out", "t_sortie", "temp_out"))
    if t_in_obj and t_out_obj:
        kpi_finaux["ΔT"] = {
            "valeur": round(float(t_out_obj["valeur"]) - float(t_in_obj["valeur"]), 3),
            "ecart_type": None,
            "variation_rel_pct": None,
            "unite": "K",
            "methode": "T_sortie − T_entrée",
            "fenetre": min(t_in_obj.get("fenetre", 0), t_out_obj.get("fenetre", 0)),
            "convergence": pire_statut([t_in_obj.get("convergence"), t_out_obj.get("convergence")]),
            "source": "calculé",
        }

    l_in = metadonnees.get("longueur_entree_dh")
    l_out = metadonnees.get("longueur_sortie_dh")
    if l_in is not None and float(l_in) < 5:
        alertes.append(f"Longueur d'établissement en entrée courte ({l_in} Dh < 5 Dh recommandés).")
    if l_out is not None and float(l_out) < 5:
        alertes.append(f"Longueur d'établissement en sortie courte ({l_out} Dh < 5 Dh recommandés).")
    if "frontieres" not in metadonnees:
        alertes.append("Liste des frontières et de leurs rôles ('frontieres') non renseignée dans metadata.json.")

    for fpath in sorted(dossier.iterdir()):
        if not fpath.is_file() or fpath.suffix.lower() not in (".xy", ".csv", ".txt"):
            continue
        nom_low = fpath.stem.lower()
        if any(mot in nom_low for mot in ("axe", "sonde")):
            try:
                df_p, alertes_p = lire_donnees_fluent(fpath)
                alertes.extend(alertes_p)
                empreintes[fpath.name] = calculer_sha256(fpath)
                x_vals = df_p.iloc[:, 0].to_numpy(dtype=float)
                y_vals = df_p.iloc[:, 1].to_numpy(dtype=float)
                if len(x_vals) > 500:
                    idx = np.linspace(0, len(x_vals) - 1, 500, dtype=int)
                    x_vals, y_vals = x_vals[idx], y_vals[idx]
                profils_extraits[fpath.stem] = {
                    "source": fpath.name,
                    "x_c": [round(float(v), 5) for v in x_vals],
                    "valeur": [round(float(v), 6) for v in y_vals],
                }
                print(f"[OK] Profil interne '{fpath.stem}' extrait : {fpath.name}")
            except Exception as e:
                alertes.append(f"Impossible de lire le profil {fpath.name} ({e}).")

    return profils_extraits, alertes


def sous_echantillonner_extrema(df: pd.DataFrame, col_x: str, max_points: int = 1000) -> pd.DataFrame:
    n = len(df)
    if n <= max_points:
        return df

    cols_y = [c for c in df.columns if c != col_x and c.lower() not in COLONNES_ABSCISSE] or list(df.columns[1:])
    nb_tranches = max(1, max_points // (2 * max(1, len(cols_y))))
    indices = {0, n - 1}

    tranches = np.array_split(df.index.to_numpy(), nb_tranches)
    for tranche in tranches:
        if len(tranche) == 0:
            continue
        sub = df.loc[tranche]
        for col in cols_y:
            indices.add(int(sub[col].idxmin()))
            indices.add(int(sub[col].idxmax()))

    return df.loc[sorted(indices)].reset_index(drop=True)


def generer_image_pyvista(
    mesh_path: Path,
    output_png: Path,
    vue: str = "xy",
    var_cible: str | None = None,
    cmap: str = "viridis",
) -> tuple[bool, list[str]]:
    alertes = []
    try:
        data = pv.read(str(mesh_path))
        mesh = data.combine().extract_surface() if isinstance(data, pv.MultiBlock) else data.extract_surface()

        var_name = None
        if var_cible and var_cible in mesh.array_names:
            var_name = var_cible
        elif mesh.array_names:
            var_name = mesh.array_names[0]

        if var_name is not None:
            valeurs = np.asarray(mesh[var_name])
            if np.nanmax(valeurs) - np.nanmin(valeurs) <= 0:
                alertes.append(f"Champ '{var_name}' constant dans {mesh_path.name} : rendu sans échelle scalaire.")
                var_name = None

        plotter = pv.Plotter(off_screen=True, window_size=[1200, 700])
        plotter.background_color = "white"
        plotter.add_mesh(
            mesh,
            scalars=var_name,
            cmap=cmap,
            show_edges=False,
            scalar_bar_args={"title": f"{var_name} ({deduire_unite(var_name)})" if var_name else ""},
        )

        vues = {
            "xy": plotter.view_xy,
            "xz": plotter.view_xz,
            "yz": plotter.view_yz,
            "iso": plotter.view_isometric,
        }
        vues.get(vue, plotter.view_xy)()

        plotter.screenshot(str(output_png))
        plotter.close()
        return True, alertes

    except Exception as e:
        alertes.append(f"Échec du rendu PyVista ({e}).")
        return False, alertes


def trouver_fichiers_courbes(dossier: Path) -> list[Path]:
    fichiers = []
    for ext in EXTENSIONS_COURBES:
        for f in sorted(dossier.glob(f"*{ext}")):
            if not any(mot in f.stem.lower() for mot in MOTS_CLES_PROFILS):
                fichiers.append(f)
    return fichiers


def trouver_premier_fichier(dossier: Path, extensions: tuple[str, ...]) -> Path | None:
    for ext in extensions:
        fichiers = sorted(dossier.glob(f"*{ext}"))
        if fichiers:
            return fichiers[0]
    return None


def gerer_doublon(nom: str, mode: str) -> tuple[str, str | None]:
    exist = (
        supabase.table("simulations")
        .select("id, nom")
        .eq("nom", nom)
        .is_("deleted_at", "null")
        .execute()
    )
    if not exist.data:
        return nom, None

    existant_id = exist.data[0]["id"]
    choix = mode

    if choix == "demander":
        print(f"\n[DOUBLON] Une simulation nommée '{nom}' existe déjà (ID: {existant_id}).")
        rep = input("Action : [R]emplacer / [N]ouvelle version / [A]nnuler ? ").strip().lower()
        if rep.startswith("r"):
            choix = "remplacer"
        elif rep.startswith("n"):
            choix = "nouvelle_version"
        else:
            choix = "annuler"

    if choix == "annuler":
        print("Ingestion annulée par l'utilisateur.")
        raise SystemExit(0)

    if choix == "remplacer":
        print(f"[INFO] Remplacement de la simulation existante '{nom}'...")
        return nom, existant_id

    v = 2
    while True:
        candidat = f"{nom}_v{v}"
        check = (
            supabase.table("simulations")
            .select("id")
            .eq("nom", candidat)
            .is_("deleted_at", "null")
            .execute()
        )
        if not check.data:
            print(f"[INFO] Création d'une nouvelle version : '{candidat}'")
            return candidat, None
        v += 1


def main():
    parser = argparse.ArgumentParser(description="Ingestion ANSYS Fluent -> Supabase (CFD Post-Pro v2.5)")
    parser.add_argument("--nom", required=True, help="Nom de la simulation")
    parser.add_argument("--dossier", required=True, help="Chemin vers le dossier d'export")
    parser.add_argument("--profil", choices=list(PROFILS_CONFIG.keys()), default="generique")
    parser.add_argument("--projet", default="Défaut")
    parser.add_argument("--description", default="")
    parser.add_argument("--tags", default="")
    parser.add_argument("--vue", choices=["xy", "xz", "yz", "iso"], default="xy")
    parser.add_argument("--var", default=None)
    parser.add_argument("--fenetre", type=int, default=100)
    parser.add_argument(
        "--doublon",
        choices=["demander", "remplacer", "nouvelle_version", "annuler"],
        default="demander",
    )
    args = parser.parse_args()

    dossier = Path(args.dossier)
    if not dossier.exists():
        raise FileNotFoundError(f"Dossier introuvable : {dossier}")

    metadonnees = {}
    meta_file = dossier / "metadata.json"
    if meta_file.exists():
        with open(meta_file, "r", encoding="utf-8") as f:
            metadonnees = json.load(f)
        print(f"[OK] Métadonnées chargées depuis {meta_file.name}")

    profil_type = metadonnees.pop("profil_type", args.profil)
    if profil_type not in PROFILS_CONFIG:
        profil_type = "generique"
    profil_cfg = PROFILS_CONFIG[profil_type]

    projet = metadonnees.pop("projet", args.projet)
    description = metadonnees.pop("description", args.description)
    tags = [t.strip() for t in args.tags.split(",") if t.strip()]
    if "tags" in metadonnees and isinstance(metadonnees["tags"], list):
        tags = list(dict.fromkeys(tags + metadonnees.pop("tags")))

    mapping_colonnes = metadonnees.pop("mapping_colonnes", {})
    conditions_imposees = metadonnees.get("conditions_imposees", [])

    nom_final, sim_id_existant = gerer_doublon(args.nom, args.doublon)

    messages_validation = []
    empreintes = {}

    for cle_req in profil_cfg["meta_requises"]:
        if cle_req not in metadonnees or metadonnees[cle_req] in (None, ""):
            messages_validation.append(
                f"Métadonnée requise manquante pour le profil '{profil_type}' : '{cle_req}'."
            )

    # 1. Fichiers de courbes (fusion côte à côte automatique si plusieurs .out)
    fichiers_courbes = trouver_fichiers_courbes(dossier)
    fichier_courbe = fichiers_courbes[0] if fichiers_courbes else None
    kpi_finaux = {}
    donnees_courbes = []

    if fichiers_courbes:
        dfs = []
        noms_sources = []
        for fc in fichiers_courbes:
            empreintes[fc.name] = calculer_sha256(fc)
            df_i, alertes_lecture = lire_donnees_fluent(fc)
            messages_validation.extend(alertes_lecture)
            dfs.append(df_i)
            noms_sources.append(fc.name)

        df = dfs[0].copy()
        for df_i in dfs[1:]:
            n_min = min(len(df), len(df_i))
            df = df.iloc[:n_min].reset_index(drop=True)
            df_i = df_i.iloc[:n_min].reset_index(drop=True)
            nouvelles_cols = [c for c in df_i.columns if c not in df.columns]
            if nouvelles_cols:
                df = pd.concat([df, df_i[nouvelles_cols]], axis=1)

        nom_source_fusion = " + ".join(noms_sources)

        if isinstance(mapping_colonnes, dict) and mapping_colonnes:
            df = df.rename(columns=mapping_colonnes)

        col_x, regime_detecte = detecter_colonne_x(df)
        metadonnees["abscisse"] = col_x
        if "regime_temporel" not in metadonnees:
            metadonnees["regime_temporel"] = regime_detecte

        kpi_finaux, alertes_kpi = calculer_kpi_enrichis(
            df,
            nom_source_fusion,
            col_x=col_x,
            regime=metadonnees["regime_temporel"],
            metadonnees=metadonnees,
            conditions_imposees=conditions_imposees,
            fenetre=args.fenetre,
        )
        messages_validation.extend(alertes_kpi)

        df_affichage = sous_echantillonner_extrema(df, col_x=col_x, max_points=1000)
        donnees_courbes = df_affichage.to_dict(orient="records")
        print(
            f"[OK] Données lues ({len(fichiers_courbes)} fichier(s)) : {nom_source_fusion} "
            f"(abscisse='{col_x}', régime='{metadonnees['regime_temporel']}', {len(df)} -> {len(df_affichage)} pts)"
        )
    else:
        messages_validation.append("Aucun fichier de courbes (.out, .csv, .txt, .xy) trouvé dans le dossier.")

    profils_paroi = {}
    if profil_type == "aile_2d":
        profils_paroi, alertes_spec = traiter_profil_aile_2d(dossier, metadonnees, kpi_finaux, empreintes)
        messages_validation.extend(alertes_spec)
    elif profil_type == "interne":
        profils_paroi, alertes_spec = traiter_profil_interne(dossier, metadonnees, kpi_finaux, empreintes)
        messages_validation.extend(alertes_spec)

    fichier_maillage = trouver_premier_fichier(dossier, EXTENSIONS_MAILLAGES)
    url_visuel = None

    if fichier_maillage:
        empreintes[fichier_maillage.name] = calculer_sha256(fichier_maillage)
        png_local = dossier / f"{nom_final}_rendu.png"
        ok_visuel, alertes_visuel = generer_image_pyvista(
            fichier_maillage,
            png_local,
            vue=args.vue,
            var_cible=args.var,
            cmap=profil_cfg["cmap"],
        )
        messages_validation.extend(alertes_visuel)

        if ok_visuel:
            storage_path = f"{nom_final}/{png_local.name}"
            with open(png_local, "rb") as f:
                supabase.storage.from_("cfd-assets").upload(
                    path=storage_path,
                    file=f,
                    file_options={"content-type": "image/png", "upsert": "true"},
                )
            url_visuel = supabase.storage.from_("cfd-assets").get_public_url(storage_path)
            print(f"[OK] Visuel généré ({fichier_maillage.name}, vue {args.vue}) : {url_visuel}")

    if not fichier_courbe and not fichier_maillage:
        statut_sim = "erreur"
        statut_val = "ERREUR"
    elif messages_validation:
        statut_sim = "partielle"
        statut_val = "AVERTISSEMENT"
    else:
        statut_sim = "complete"
        statut_val = "OK"

    rapport_validation = {
        "statut": statut_val,
        "messages": messages_validation,
        "composants": {
            "courbes": bool(fichier_courbe),
            "parois": bool(profils_paroi),
            "champs": bool(url_visuel),
            "metadonnees": bool(metadonnees),
        },
    }

    print(f"\n--- Résumé validation : {statut_val} (statut simulation : {statut_sim}) ---")
    for msg in messages_validation:
        print(f"  - {msg}")

    payload_sim = {
        "nom": nom_final,
        "description": description,
        "profil_type": profil_type,
        "profil_version": profil_cfg["version"],
        "statut": statut_sim,
        "projet": projet,
        "metadonnees": metadonnees,
        "validation": rapport_validation,
        "tags": tags,
        "script_version": SCRIPT_VERSION,
        "empreintes_fichiers": empreintes,
        "kpi_finaux": kpi_finaux,
        "profils_paroi": profils_paroi,
        "url_visuel_3d": url_visuel,
    }

    if sim_id_existant:
        supabase.table("simulations").update(payload_sim).eq("id", sim_id_existant).execute()
        sim_id = sim_id_existant
        supabase.table("convergence_data").delete().eq("simulation_id", sim_id).execute()
    else:
        res = supabase.table("simulations").insert(payload_sim).execute()
        sim_id = res.data[0]["id"]

    if donnees_courbes:
        supabase.table("convergence_data").insert({
            "simulation_id": sim_id,
            "donnees": donnees_courbes,
        }).execute()

    print(f"\n[SUCCÈS] Ingestion terminée ! ID simulation : {sim_id}")


if __name__ == "__main__":
    main()