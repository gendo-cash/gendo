// Each catalogue app's logo, by app name. The files are the apps' own, bundled with the app.
import minswap from "./apps/minswap.svg";

const LOGOS: Record<string, string> = { minswap };

export function AppLogo({ name, size = 20 }: { name: string; size?: number }) {
  const src = LOGOS[name];
  return src ? <img src={src} alt="" width={size} height={size} style={{ flex: "none", display: "block" }} /> : null;
}
