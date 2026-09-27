/** Shared platform mark: a doorway between the pages of a story. */
export default function TavernMark({ className }: { className?: string }) {
  return <img className={className} src={import.meta.env.BASE_URL + "ark-tavern.svg"} alt="" aria-hidden="true" draggable={false} />;
}
