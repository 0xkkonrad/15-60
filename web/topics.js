/* Named concepts for the daily 15:60 exercise.
 *
 * Categories stay explicit for editorial checks. The public topic stream is
 * interleaved by category, so each of a day's four possible choices comes
 * from a different field while remaining deterministic and offline-first. */
export const TOPIC_CATEGORIES = Object.freeze(
[
  "economics",
  "political-theory",
  "strategy-and-game-theory",
  "biology",
  "medicine-and-public-health",
  "earth-and-climate",
  "physics",
  "chemistry-and-materials",
  "mathematics",
  "statistics-and-measurement",
  "cognition-and-reasoning",
  "paradoxes",
  "philosophy",
  "linguistics",
  "anthropology-and-sociology",
  "history",
  "art-and-architecture",
  "music-and-narrative-craft",
  "technology-and-engineering"
]);

export const TOPIC_CATALOG = Object.freeze({
  "economics": Object.freeze([
    "Coase theorem",
    "Comparative advantage",
    "Gresham’s law",
    "Jevons paradox",
    "Baumol’s cost disease",
    "Dutch disease",
    "Adverse selection",
    "Moral hazard",
    "Principal–agent problem",
    "Keynesian beauty contest",
    "Veblen good",
    "Impossible trinity"
  ]),
  "political-theory": Object.freeze([
    "Social contract",
    "Rousseau’s general will",
    "Harm principle",
    "Positive and negative liberty",
    "Veil of ignorance",
    "Republican non-domination",
    "Tyranny of the majority",
    "Subsidiarity",
    "Polycentric governance",
    "Mandate of Heaven",
    "Swaraj",
    "Constitutional morality"
  ]),
  "strategy-and-game-theory": Object.freeze([
    "Nash equilibrium",
    "Prisoner’s dilemma",
    "Stag hunt",
    "Game of chicken",
    "Schelling point",
    "Backward induction",
    "Credible commitment",
    "Signaling game",
    "Mixed strategy",
    "Minimax theorem",
    "Folk theorem",
    "Evolutionarily stable strategy"
  ]),
  "biology": Object.freeze([
    "Natural selection",
    "Hardy–Weinberg equilibrium",
    "Genetic drift",
    "Central dogma of molecular biology",
    "Operon model of gene regulation",
    "Endosymbiotic theory",
    "Horizontal gene transfer",
    "Inclusive fitness",
    "Red Queen hypothesis",
    "Keystone species",
    "Morphogen gradients",
    "Niche construction"
  ]),
  "medicine-and-public-health": Object.freeze([
    "Herd immunity",
    "Basic and effective reproduction numbers (R₀ and Rₜ)",
    "Antimicrobial resistance",
    "One Health",
    "Social determinants of health",
    "Prevention paradox",
    "Inverse care law",
    "Lead-time bias",
    "Disability-adjusted life year (DALY)",
    "Syndemic theory",
    "Epidemiologic transition",
    "Bradford Hill viewpoints"
  ]),
  "earth-and-climate": Object.freeze([
    "Plate tectonics",
    "Milankovitch cycles",
    "Carbonate–silicate weathering thermostat",
    "Greenhouse effect",
    "Ice–albedo feedback",
    "El Niño–Southern Oscillation (ENSO)",
    "Thermohaline circulation",
    "Hadley circulation",
    "Rain-shadow effect",
    "Ocean acidification",
    "Isostasy",
    "Paleoclimate proxies"
  ]),
  "physics": Object.freeze([
    "Noether’s theorem",
    "Equivalence principle",
    "Relativity of simultaneity",
    "Second law of thermodynamics",
    "Wave–particle duality",
    "Heisenberg uncertainty principle",
    "Quantum tunneling",
    "Pauli exclusion principle",
    "Doppler effect",
    "Resonance",
    "Principle of stationary action",
    "Spontaneous symmetry breaking"
  ]),
  "chemistry-and-materials": Object.freeze([
    "Le Châtelier’s principle",
    "Activation energy and catalysis",
    "Electronegativity and bond polarity",
    "Intermolecular forces",
    "Phase diagram and triple point",
    "Molecular chirality",
    "Aromaticity",
    "Polymer cross-linking",
    "Crystal dislocations",
    "Electronic band gap",
    "Galvanic corrosion",
    "Atom economy"
  ]),
  "mathematics": Object.freeze([
    "Pigeonhole principle",
    "Cantor’s diagonal argument",
    "Euler characteristic",
    "Eulerian path",
    "Gödel’s first incompleteness theorem",
    "Banach fixed-point theorem",
    "Fourier transform",
    "Non-Euclidean geometry",
    "Fractal dimension",
    "Mathematical induction",
    "Sensitive dependence on initial conditions",
    "Group theory of symmetry"
  ]),
  "statistics-and-measurement": Object.freeze([
    "Law of large numbers",
    "Central limit theorem",
    "Regression to the mean",
    "Confounding",
    "Randomization",
    "Confidence interval",
    "P-value",
    "Multiple-comparisons problem",
    "Bayesian updating",
    "Sampling bias",
    "Accuracy, precision, and measurement uncertainty",
    "Capture–recapture estimation"
  ]),
  "cognition-and-reasoning": Object.freeze([
    "Signal detection theory",
    "Cognitive dissonance",
    "Availability heuristic",
    "Anchoring effect",
    "Dual-process theory",
    "Einstellung effect",
    "Curse of knowledge",
    "Predictive processing",
    "Spacing effect",
    "Inattentional blindness",
    "Motivated reasoning",
    "Peak-end rule"
  ]),
  "paradoxes": Object.freeze([
    "Ship of Theseus",
    "Sorites paradox",
    "Liar paradox",
    "Russell's paradox",
    "Zeno's Achilles paradox",
    "Simpson's paradox",
    "Braess's paradox",
    "Monty Hall problem",
    "Birthday paradox",
    "Newcomb's problem",
    "Parrondo's paradox",
    "Raven paradox"
  ]),
  "philosophy": Object.freeze([
    "Epistemic injustice",
    "Allegory of the cave",
    "Golden mean",
    "Cogito",
    "Problem of induction",
    "Categorical imperative",
    "Gettier problem",
    "Chinese room",
    "Experience machine",
    "Mary’s room",
    "Nāgārjuna’s emptiness",
    "Mencius’s child at the well"
  ]),
  "linguistics": Object.freeze([
    "Gricean implicature",
    "Linguistic relativity",
    "Zipf's law",
    "Grammaticalization",
    "Evidentiality",
    "Diglossia",
    "Sprachbund",
    "Code-switching",
    "Ergative–absolutive alignment",
    "Tone sandhi",
    "Bouba-kiki effect",
    "Wug test"
  ]),
  "anthropology-and-sociology": Object.freeze([
    "Gift exchange",
    "Liminality",
    "Habitus",
    "Imagined community",
    "Anomie",
    "Double consciousness",
    "Dramaturgical analysis",
    "Social construction of reality",
    "Asabiyyah",
    "Moral economy",
    "Structural violence",
    "Purity and danger"
  ]),
  "history": Object.freeze([
    "Axial Age",
    "Columbian Exchange",
    "Great Divergence",
    "Longue durée",
    "Late Bronze Age collapse",
    "Pax Mongolica",
    "Haitian Revolution",
    "Tanzimat reforms",
    "Meiji Restoration",
    "Berlin Conference",
    "Partition of India",
    "Bandung Conference"
  ]),
  "art-and-architecture": Object.freeze([
    "Japonisme",
    "Chiaroscuro",
    "Anamorphosis",
    "Horror vacui",
    "Rasa theory",
    "Ma",
    "Shan shui",
    "Muqarnas",
    "Talud-tablero",
    "Gesamtkunstwerk",
    "Metabolist architecture",
    "Brutalism"
  ]),
  "music-and-narrative-craft": Object.freeze([
    "Leitmotif",
    "Polyrhythm",
    "Clave",
    "Raga",
    "Maqam",
    "Kotekan",
    "Chekhov's gun",
    "In medias res",
    "Free indirect discourse",
    "Unreliable narrator",
    "Rashomon effect",
    "Kishōtenketsu"
  ]),
  "technology-and-engineering": Object.freeze([
    "Byzantine Generals problem",
    "CAP theorem",
    "End-to-end principle",
    "Conway's law",
    "Poka-yoke",
    "TRIZ",
    "Fault-tree analysis",
    "Swiss cheese model",
    "PID controller",
    "Tensegrity",
    "Digital twin",
    "Graceful degradation"
  ]),
});

const rows = Math.max(...TOPIC_CATEGORIES.map((category) => TOPIC_CATALOG[category].length));

export const TOPIC_RECORDS = Object.freeze(
  Array.from({ length: rows }, (_, row) =>
    TOPIC_CATEGORIES.flatMap((category) => {
      const prompt = TOPIC_CATALOG[category][row];
      return prompt ? [Object.freeze({ category, prompt })] : [];
    }))
    .flat(),
);

export const TOPICS = Object.freeze(TOPIC_RECORDS.map(({ prompt }) => prompt));
