import { useState } from "react";

interface Props {
  imageUrl: string;
  characterName: string;
}

function IllustrationImage({ imageUrl, characterName }: Props) {
  const [imgError, setImgError] = useState(false);

  if (imgError) return null;

  return (
    <div className="character-illustration-container">
      <img
        src={imageUrl}
        alt={characterName}
        onError={() => setImgError(true)}
        className="character-illustration-img"
      />
    </div>
  );
}

export default function CharacterIllustration(props: Props) {
  // A new URL owns new error state; late events from the old image cannot hide it.
  if (!props.imageUrl) return null;
  return <IllustrationImage key={props.imageUrl} {...props} />;
}
