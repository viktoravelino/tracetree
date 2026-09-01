import { memo, useEffect, useRef, useState } from "react";
import { ImageOffIcon, XIcon } from "lucide-react";

import type { Message, MessageImage } from "../../src/contract.ts";
import { cn } from "@/lib/utils";

/**
 * Images attached to a message.
 *
 * The descriptors arrive without pixels — see `MessageImage` — so each tile
 * fetches its own bytes from the per-image route. That keeps a page of a
 * hundred messages a few kilobytes of JSON instead of tens of megabytes, and
 * lets the browser cache and lazy-load what is actually looked at.
 *
 * Every tile is a fixed-height box before it holds anything. That is not
 * cosmetic: the transcript pins itself to the bottom, and an image that
 * resolved its own height on load would grow the content box after layout and
 * shove the view off the tail. Reserving the box up front means loading,
 * loaded, and failed all occupy exactly the same space.
 */

/** Height of a thumbnail's reserved box, and so of every state it can be in. */
const TILE_HEIGHT = "h-32";

/** A `MessageImage` carrying the message it came from, which its URL needs. */
export interface AttachedImage extends MessageImage {
  messageUuid: string;
}

/** Flattens a turn's messages into one list of images, in order. */
export function collectImages(messages: readonly Message[]): AttachedImage[] {
  return messages.flatMap((message) =>
    message.images.map((image) => ({ ...image, messageUuid: message.uuid })),
  );
}

function imageUrl(sessionId: string, image: AttachedImage): string {
  const session = encodeURIComponent(sessionId);
  const uuid = encodeURIComponent(image.messageUuid);
  return `/api/sessions/${session}/messages/${uuid}/images/${image.index}`;
}

/** "412 KB" — enough to judge an image without spelling out the byte count. */
function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** "image/png" -> "PNG"; anything unexpected is shown as-is. */
function typeLabel(mediaType: string): string {
  const subtype = mediaType.split("/")[1];
  return (subtype ?? mediaType).toUpperCase();
}

interface MessageImagesProps {
  sessionId: string;
  images: readonly AttachedImage[];
}

export const MessageImages = memo(function MessageImages({
  sessionId,
  images,
}: MessageImagesProps) {
  /** Index into `images` of the one shown full size, or null. */
  const [zoomed, setZoomed] = useState<number | null>(null);

  if (images.length === 0) return null;

  const shown = zoomed === null ? undefined : images[zoomed];

  return (
    <div className="mt-3">
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
        {images.map((image, index) => (
          <li key={`${image.messageUuid}:${image.index}`}>
            <Thumbnail
              src={imageUrl(sessionId, image)}
              alt={`Attached image ${index + 1} of ${images.length}`}
              image={image}
              onOpen={() => setZoomed(index)}
            />
          </li>
        ))}
      </ul>
      {shown !== undefined && zoomed !== null && (
        <Lightbox
          src={imageUrl(sessionId, shown)}
          alt={`Attached image ${zoomed + 1} of ${images.length}, full size`}
          image={shown}
          onClose={() => setZoomed(null)}
        />
      )}
    </div>
  );
});

type LoadState = "loading" | "loaded" | "failed";

function Thumbnail({
  src,
  alt,
  image,
  onOpen,
}: {
  src: string;
  alt: string;
  image: AttachedImage;
  onOpen: () => void;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const caption = `${typeLabel(image.mediaType)} · ${humanBytes(image.bytes)}`;

  return (
    <figure className="m-0">
      <button
        type="button"
        onClick={onOpen}
        // Failing images stay focusable and clickable: the route may simply
        // have been slow or restarting, and opening retries the fetch.
        aria-label={state === "failed" ? `${alt} (failed to load)` : `${alt}, view full size`}
        className={cn(
          "block w-full cursor-pointer overflow-hidden rounded-md border border-border bg-muted/40",
          "transition-colors hover:border-primary/50",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          TILE_HEIGHT,
        )}
      >
        {state === "failed" ? (
          <span className="flex h-full flex-col items-center justify-center gap-1 px-2 text-center">
            <ImageOffIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="font-mono text-[0.625rem] leading-tight text-muted-foreground">
              Image could not be loaded
            </span>
          </span>
        ) : (
          <img
            src={src}
            alt={alt}
            loading="lazy"
            decoding="async"
            onLoad={() => setState("loaded")}
            onError={() => setState("failed")}
            className={cn(
              "h-full w-full object-contain transition-opacity",
              state === "loaded" ? "opacity-100" : "opacity-0",
            )}
          />
        )}
      </button>
      <figcaption className="mt-1 truncate font-mono text-[0.625rem] text-muted-foreground">
        {caption}
      </figcaption>
    </figure>
  );
}

/**
 * Full-size view, as a native modal `<dialog>`.
 *
 * Chosen over a hand-rolled overlay because the platform already does the parts
 * that are easy to get wrong: Escape closes it, focus is trapped for as long as
 * it is open and handed back to the trigger when it closes, and the top layer
 * puts it above everything without a z-index. It is also `position: fixed`, so
 * it contributes nothing to the transcript's content height and cannot disturb
 * the resize observer that keeps follow mode pinned.
 */
function Lightbox({
  src,
  alt,
  image,
  onClose,
}: {
  src: string;
  alt: string;
  image: AttachedImage;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const [failed, setFailed] = useState(false);
  /**
   * Set when this component closes the dialog itself, cleared by the very event
   * that close produces.
   *
   * `<dialog onClose>` fires for *any* close, including the one this effect
   * performs on cleanup, so without a guard that cleanup reports itself as the
   * user dismissing the image and StrictMode's mount/unmount/mount closes the
   * lightbox the instant it opens. The flag cannot be cleared straight after
   * `close()` either: the event is dispatched as a task, so it arrives long
   * after that line runs. Only the handler knows when it has been consumed.
   */
  const closingSelf = useRef(false);

  useEffect(() => {
    const element = dialog.current;
    if (element === null || element.open) return;
    element.showModal();
    return () => {
      // Guard only when there is a close to suppress, or the flag would linger
      // and swallow the user's first real dismissal.
      if (!element.open) return;
      closingSelf.current = true;
      element.close();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      // Escape and the backdrop both route through the same close, so state
      // never drifts from what the browser is actually showing.
      onClose={() => {
        if (closingSelf.current) {
          closingSelf.current = false;
          return;
        }
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
      aria-label={alt}
      className={cn(
        "relative fixed inset-0 m-auto max-h-[90vh] max-w-[90vw] rounded-lg border border-border bg-card p-3",
        "text-foreground backdrop:bg-background/80",
      )}
    >
      {failed ? (
        <p className="flex h-40 w-64 flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
          <ImageOffIcon className="size-5" aria-hidden="true" />
          Image could not be loaded.
        </p>
      ) : (
        <img
          src={src}
          alt={alt}
          decoding="async"
          onError={() => setFailed(true)}
          className="max-h-[80vh] max-w-[86vw] rounded object-contain"
        />
      )}
      {/* Escape and the backdrop both close this, but neither is discoverable;
          a button is the only affordance that announces itself. */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close the full-size image"
        className={cn(
          "absolute top-2 right-2 flex size-7 items-center justify-center rounded-md",
          "bg-background/80 text-muted-foreground hover:text-foreground",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
      >
        <XIcon className="size-4" aria-hidden="true" />
      </button>
      <p className="mt-2 font-mono text-[0.625rem] text-muted-foreground">
        {typeLabel(image.mediaType)} · {humanBytes(image.bytes)} · Escape or click outside to close
      </p>
    </dialog>
  );
}
