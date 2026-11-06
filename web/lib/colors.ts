export const PALETTE = [
  "#58a6ff",
  "#3fb950",
  "#f778ba",
  "#d29922",
  "#a371f7",
  "#39c5cf",
  "#ff7b72",
  "#7ee787",
  "#ffa657",
  "#79c0ff",
];

export const stationColor = (id: number) => PALETTE[(id - 1) % PALETTE.length];
