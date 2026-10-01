export type PlaybackState = {
  paused: boolean;
  position: number;
  duration: number;
  track_window?: { current_track?: { uri: string } };
};
export type PlayerError = { message: string };
export type SpotifyPlayer = {
  connect(): Promise<boolean>;
  disconnect(): void;
  activateElement(): Promise<void>;
  togglePlay(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  getCurrentState(): Promise<PlaybackState | null>;
  addListener(event: string, callback: (value: any) => void): void;
};

declare global {
  interface Window {
    Spotify?: {
      Player: new (options: {
        name: string;
        getOAuthToken: (callback: (token: string) => void) => void;
        volume: number;
      }) => SpotifyPlayer;
    };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

let sdkPromise: Promise<void> | undefined;
export function loadSpotifySdk(): Promise<void> {
  if (window.Spotify) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<void>((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    script.onerror = () =>
      reject(
        new Error(
          "The Spotify player could not load. Check your connection and try again.",
        ),
      );
    document.head.appendChild(script);
  });
  return sdkPromise;
}
