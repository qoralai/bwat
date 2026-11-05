import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, sessionGone, messageFor } from './api';
import { LoadError } from './LoadError';

/* The picture bwat shows as its video in meetings (D196): the logo it ships with, or one an
   owner or admin uploads. It saves on its own, apart from the save bar. */
const PRESENCE_URL = '/v1/console/settings/presence-image';
// The bot's bundled logo (bot/presence/default.png), copied into the panel's build.
const DEFAULT_PICTURE = '/admin/presence-default.png';

/** Bytes as a data: URL: the page's CSP allows img-src 'self' data: only, never blob:. */
const dataUrl = (bytes: Uint8Array, type: string) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(text)}`;
};

/** The uploaded picture as a data: URL, or null while the bot shows the default logo. */
const fetchPicture = async (): Promise<string | null> => {
  const res = await api('GET', PRESENCE_URL);
  if (res.status === 204) return null;
  return dataUrl(new Uint8Array(await res.arrayBuffer()), res.headers.get('content-type') || 'image/png');
};

const PRESENCE_ERRORS: Record<string, string> = {
  not_16_9: 'The picture must be 16:9. Nothing was saved.',
  not_an_image: 'Choose a PNG or JPEG picture. Nothing was saved.',
  unsupported_media_type: 'Choose a PNG or JPEG picture. Nothing was saved.',
  too_large: 'The picture must be 2 MB or smaller. Nothing was saved.',
  too_many_pixels: 'The picture must be at most 3840 by 2160. Nothing was saved.',
  forbidden: 'Only admins can change the picture.',
};

/**
 * How people see bwat in a meeting: one 16:9 tile, shaped like a meeting's
 * video tile, with the picture and the name the meeting will show. The name is the
 * page's draft, so the tile follows it as it is typed; `children` is that field.
 */
export function PresencePicture({ name, children }: { name: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const current = useQuery({ queryKey: ['presence-image'], queryFn: fetchPicture });
  const [problem, setProblem] = useState<string | null>(null);
  // A picture the server just took fades in; the one on opening the page does not.
  const [fresh, setFresh] = useState(false);
  // Undefined until the picture is read (or when it cannot be): then neither picture is claimed.
  const known = current.data !== undefined;
  const uploaded = current.data ?? null;
  const src = uploaded ?? DEFAULT_PICTURE;
  const onError = (error: Error) => {
    if (!sessionGone(error)) setProblem(messageFor(error, PRESENCE_ERRORS));
  };
  const upload = useMutation({
    // The server judges the picture (type, 16:9, size) by its bytes, whatever its name or the
    // browser's type say; the header only has to be one of the two it takes.
    mutationFn: (file: File) =>
      api('PUT', PRESENCE_URL, new Blob([file], { type: file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png' })),
    onSuccess: () => {
      setFresh(true);
      return queryClient.invalidateQueries({ queryKey: ['presence-image'] });
    },
    onError,
  });
  const backToDefault = useMutation({
    mutationFn: () => api('DELETE', PRESENCE_URL),
    onSuccess: () => {
      setFresh(true);
      queryClient.setQueryData(['presence-image'], null);
    },
    onError,
  });
  const choose = (file: File | undefined) => {
    setProblem(null);
    if (file) upload.mutate(file);
  };
  const busy = upload.isPending || backToDefault.isPending;
  return (
    <div className="presence">
      <div className="tile">
        {known && <img key={src} className={fresh ? 'fresh' : undefined} src={src} alt="The picture bwat shows in meetings" />}
        <span className="lbl">{name}</span>
      </div>
      <div className="presence-fields">
        <p className="muted small">How people see bwat in the meeting</p>
        {children}
        <div role="group" className="setting inline presence-picture" aria-labelledby="presence-picture">
          <span className="l">
            <span id="presence-picture" className="setting-label">
              Picture
            </span>
            <small className="muted">
              {known && (uploaded ? 'Your picture · ' : 'The default logo · ')}16:9, up to 2 MB
            </small>
          </span>
          <span className="actions">
            <button type="button" className="button quiet" disabled={busy || !uploaded} onClick={() => backToDefault.mutate()}>
              Use the default
            </button>
            <label className="button">
              Upload
              <input
                type="file"
                accept="image/png,image/jpeg"
                aria-label="Upload a picture"
                className="visually-hidden"
                disabled={busy}
                onChange={(e) => {
                  void choose(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
          </span>
          <LoadError what="the picture" error={current.error} />
          {problem && (
            <p role="alert" className="error">
              {problem}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
