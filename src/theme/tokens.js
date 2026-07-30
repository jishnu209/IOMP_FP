// ── Legacy theme tokens + Proxy theme (P) ────────────────────────────────────
// Compatibility bridge for the S2 migration. The app has ~2,500 `P.*` color
// references; keeping the Proxy here lets every component keep working while it
// is migrated to React Spectrum S2 design tokens. As components move to S2,
// their `P.*` reads go away; once all are gone this file can be deleted.

export const LIGHT = {
  bg:"#F5F5F5", panel:"#FFFFFF", surface:"#FAFAFA",
  border:"#E1E1E1", bfaint:"#EDEDED", hovGrey:"#F0F0F0", selGrey:"#E4E4E4",
  brand:"#FA0F00",
  blue:"#EB1000", blueDk:"#C90D00", blueGh:"#FFF1ED",
  txt:"#222222", muted:"#4B4B4B", dim:"#8C8C8C",
  red:"#D93025", redBg:"#FEF1F0",
  amber:"#B86B00", amberBg:"#FFF5E0",
  grn:"#5C5C5C", grnBg:"#EDEDED",
  purple:"#6030D0", purpleBg:"#F0EAFF",
  blueGhDk:"#FFB4AC",
  shadow:"0 1px 3px rgba(15,20,60,.06),0 4px 12px rgba(15,20,60,.04)",
  shadowHv:"0 4px 16px rgba(15,20,60,.10),0 1px 4px rgba(15,20,60,.06)",
};

export const DARK = {
  bg:"#090A10", panel:"#111218", surface:"#181920",
  border:"#22242F", bfaint:"#161720", hovGrey:"#20222C", selGrey:"#2A2D3A",
  brand:"#FF3B30",
  blue:"#FF5A52", blueDk:"#EB1000", blueGh:"#2A1213",
  txt:"#ECEEF5", muted:"#7A80A0", dim:"#383D58",
  red:"#FF5A52", redBg:"#1C0D0D",
  amber:"#FFB020", amberBg:"#1A1208",
  grn:"#B9BDC9", grnBg:"#23252F",
  purple:"#9B72FF", purpleBg:"#130D24",
  blueGhDk:"#3A1A1A",
  shadow:"0 1px 3px rgba(0,0,0,.3),0 4px 12px rgba(0,0,0,.2)",
  shadowHv:"0 4px 16px rgba(0,0,0,.4),0 1px 4px rgba(0,0,0,.3)",
};

// Mutable module-level mode. Read via getThemeMode(); change via setThemeMode()
// so the reassignment lives in this module (imported bindings are read-only).
let THEME_MODE =
  (typeof localStorage !== "undefined" && localStorage.getItem("nexus_theme")) || "light";

export const getThemeMode = () => THEME_MODE;

export function setThemeMode(mode) {
  THEME_MODE = mode === "dark" ? "dark" : "light";
  if (typeof localStorage !== "undefined") localStorage.setItem("nexus_theme", THEME_MODE);
  // Notify subscribers (e.g. the S2 Provider) so React Spectrum components
  // restyle to the new colorScheme at runtime, not just on initial mount.
  if (typeof window !== "undefined") window.dispatchEvent(new Event("nexusthemechange"));
  return THEME_MODE;
}

export const toggleThemeMode = () => setThemeMode(THEME_MODE === "light" ? "dark" : "light");

// Proxy that resolves token names against the active palette at read time.
export const P = new Proxy({}, { get: (_, k) => (THEME_MODE === "dark" ? DARK : LIGHT)[k] });
