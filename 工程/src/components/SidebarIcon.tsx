export default function SidebarIcon({ path, color }: { path: string; color?: string }) {
  return <svg className="ico" viewBox="0 0 24 24" aria-hidden="true" style={color ? { color, stroke: color } : undefined}><path d={path} /></svg>;
}
