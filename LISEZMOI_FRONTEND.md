# Étape 4 : Tester le site web en local

**Objectif :** Vérifier que ton interface web (React + Plotly) affiche bien tes simulations stockées dans Supabase avant de la mettre en ligne.

## Prérequis
Avoir **Node.js** installé sur ton PC ([https://nodejs.org](https://nodejs.org)).

## Action 1 : Configurer les clés Supabase
1. Duplique le fichier `.env.example` et renomme la copie en `.env`.
2. Remplis `VITE_SUPABASE_URL` et `VITE_SUPABASE_ANON_KEY` avec tes clés de l'étape 2.

## Action 2 : Installer et lancer le site
Ouvre un terminal dans ce dossier (`04_Frontend_Web/`) et lance :
```bash
npm install
npm run dev
```

Ouvre ensuite ton navigateur sur l'adresse affichée (généralement `http://localhost:5173`).
Une fois que tu vois tes simulations s'afficher, passe au dossier **`05_GitHub_et_Netlify/`**.
