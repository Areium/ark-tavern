/** Shared logo used on the home screen. */
export default function TavernMark({ className }: { className?: string }) {
  return <img className={className} src={import.meta.env.BASE_URL + "logo.png"} alt="" aria-hidden="true" draggable={false} />;
}
