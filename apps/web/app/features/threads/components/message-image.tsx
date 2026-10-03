import { AspectRatio } from "@astryxdesign/core/AspectRatio";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { useLightbox } from "@astryxdesign/core/Lightbox";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { useEffect, useState } from "react";

import { localImage, releaseLocalImage } from "~/features/files/local-images";
import type { File } from "~/gen/heveta/v1/file_pb";
import { useT } from "~/i18n/use-t";

// Sent images read at a glance in the transcript, like mainstream chat apps;
// the lightbox shows them full size.
const maxSide = 320;

export default function MessageImage({ file }: { file: File }) {
	const t = useT();
	// An image this device just sent shows from its own copy, the one its
	// message showed while it was on its way, until the server's has loaded
	// here (local-images.ts); then from the server's, on the same <img>, which
	// keeps showing its image until the new one is ready. If the server's does
	// not load, the local copy stays.
	const [local, setLocal] = useState(() => localImage(file.id));
	useEffect(() => {
		if (!local) return;
		let current = true;
		const server = new Image();
		server.src = file.url;
		server.decode().then(
			() => {
				if (!current) return;
				setLocal(undefined);
				releaseLocalImage(file.id);
			},
			() => {},
		);
		return () => {
			current = false;
		};
	}, [local, file.id, file.url]);
	const src = local ?? file.url;
	const alt = file.fileName || t("threads.image");
	const lightbox = useLightbox({ media: { src, alt } });
	// The file records an image's size, so its box has its shape before it
	// loads; one whose size could not be read is measured when it loads.
	const [measured, setMeasured] = useState<number>();
	const ratio =
		file.width && file.height ? file.width / file.height : (measured ?? 4 / 3);
	const [failed, setFailed] = useState(false);
	if (failed) return <Thumbnail alt={alt} label={alt} />;
	const width = Math.round(Math.min(maxSide, maxSide * ratio));
	return (
		<>
			{/* The whole image is one control: a borderless ClickableCard clips it
			to the card's rounded corners and names the action. */}
			<ClickableCard
				label={t("threads.viewImage", { name: alt })}
				onClick={() => lightbox.open()}
				variant="transparent"
				padding={0}
				width={width}
				maxWidth="100%"
			>
				<AspectRatio ratio={ratio} fit="cover">
					<img
						src={src}
						alt={alt}
						onLoad={(event) => {
							const { naturalWidth, naturalHeight } = event.currentTarget;
							if (naturalWidth && naturalHeight)
								setMeasured(naturalWidth / naturalHeight);
						}}
						onError={() => setFailed(true)}
					/>
				</AspectRatio>
			</ClickableCard>
			{lightbox.element}
		</>
	);
}
