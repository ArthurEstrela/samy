import { Room, RoomEvent, Track } from 'livekit-client';
import type { RemoteTrack } from 'livekit-client';

export interface CallRoomHandle {
  setMuted(muted: boolean): void;
  disconnect(): Promise<void>;
}

export async function connectCallRoom(url: string, token: string): Promise<CallRoomHandle> {
  const room = new Room();
  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      el.style.display = 'none';
      document.body.appendChild(el);
    }
  });
  await room.connect(url, token);
  await room.localParticipant.setMicrophoneEnabled(true);
  return {
    setMuted: (muted: boolean): void => { void room.localParticipant.setMicrophoneEnabled(!muted); },
    disconnect: async (): Promise<void> => { await room.disconnect(); },
  };
}
