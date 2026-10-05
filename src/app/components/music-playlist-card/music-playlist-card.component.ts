import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MusicDiscoveryService } from '../../services/music-discovery.service';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicLibraryItem, MusicMix, MusicPlaylist, MusicTrack, UserPlaylist } from '../../services/music.service';
import { MusicCardMenuButtonComponent } from '../music-card-menu-button/music-card-menu-button.component';

export type MusicPlaylistLike = MusicPlaylist | UserPlaylist | MusicMix;

/**
 * Card for a TIDAL playlist, a TIDAL mix or one of the visitor's playlists
 * (a 2x2 collage of its first covers when it has no cover). Hover Play, card menu.
 */
@Component({
  selector: 'app-music-playlist-card',
  imports: [RouterLink, MusicCardMenuButtonComponent],
  templateUrl: './music-playlist-card.component.html',
  host: { class: 'block' },
})
export class MusicPlaylistCardComponent {
  readonly playlist = input.required<MusicPlaylistLike>();
  /** Where the card goes; defaults to the playlist/mix/library page. */
  readonly link = input<string | unknown[] | null>(null);

  private discovery = inject(MusicDiscoveryService);
  private player = inject(MusicPlayerService);
  private toast = inject(MusicToastService);

  protected readonly busy = signal(false);

  protected readonly item = computed<MusicLibraryItem>(() => {
    const p = this.playlist();
    if (isUserPlaylist(p)) return { kind: 'userPlaylist', data: p };
    if (isTidalPlaylist(p)) return { kind: 'playlist', data: p };
    return { kind: 'mix', data: p };
  });

  protected readonly view = computed(() => {
    const it = this.item();
    switch (it.kind) {
      case 'userPlaylist': {
        const p = it.data;
        const covers = [...new Set(p.tracks.map((t) => t.cover).filter(Boolean))].slice(0, 4);
        return {
          title: p.name,
          subtitle: `${p.tracks.length} ${p.tracks.length === 1 ? 'song' : 'songs'}`,
          cover: p.cover || (covers.length < 4 ? covers[0] ?? '' : ''),
          collage: !p.cover && covers.length >= 4 ? covers : [],
          link: this.link() ?? ['/music/library/playlist', p.id],
        };
      }
      case 'playlist': {
        const p = it.data;
        return {
          title: p.title,
          subtitle: p.creator || `${p.tracks} songs`,
          cover: p.cover,
          collage: [] as string[],
          link: this.link() ?? ['/music/playlist', p.uuid],
        };
      }
      default: {
        const m = it.data as MusicMix;
        return { title: m.title, subtitle: m.subTitle, cover: m.cover, collage: [] as string[], link: this.link() ?? ['/music/mix', m.id] };
      }
    }
  });

  protected async play(): Promise<void> {
    const it = this.item();
    this.busy.set(true);
    try {
      let tracks: MusicTrack[] = [];
      if (it.kind === 'userPlaylist') tracks = it.data.tracks;
      else if (it.kind === 'playlist') tracks = (await firstValueFrom(this.discovery.playlist(it.data.uuid))).tracks;
      else if (it.kind === 'mix') tracks = (await firstValueFrom(this.discovery.mix(it.data.id))).tracks;
      if (!tracks.length) throw new Error('empty');
      const type = it.kind === 'userPlaylist' ? 'userPlaylist' : it.kind === 'playlist' ? 'playlist' : 'mix';
      const id = it.kind === 'playlist' ? it.data.uuid : it.kind === 'userPlaylist' || it.kind === 'mix' ? it.data.id : '';
      await this.player.play(tracks[0], tracks, { context: { type, id, label: this.view().title } });
    } catch {
      this.toast.show({ message: `Couldn't play ${this.view().title}`, tone: 'warn' });
    } finally {
      this.busy.set(false);
    }
  }
}

function isUserPlaylist(p: MusicPlaylistLike): p is UserPlaylist {
  return Array.isArray((p as UserPlaylist).tracks);
}

function isTidalPlaylist(p: MusicPlaylistLike): p is MusicPlaylist {
  return typeof (p as MusicPlaylist).uuid === 'string';
}
