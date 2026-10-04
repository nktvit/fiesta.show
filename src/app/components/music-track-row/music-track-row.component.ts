import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicTrack } from '../../services/music.service';

/** One song in a list. The cover/number cell is the play button; the artist and album are links. */
@Component({
  selector: 'app-music-track-row',
  imports: [RouterLink],
  templateUrl: './music-track-row.component.html',
  host: { class: 'block' },
})
export class MusicTrackRowComponent {
  readonly track = input.required<MusicTrack>();
  /** The list this row belongs to - what next/previous walk through. */
  readonly queue = input.required<MusicTrack[]>();
  /** Show the cover art; albums show the track number instead. */
  readonly showCover = input(true);
  readonly showAlbum = input(true);
  readonly number = input<number | null>(null);

  protected readonly player = inject(MusicPlayerService);
  protected readonly current = computed(() => this.player.track()?.id === this.track().id);
  protected readonly active = computed(() => this.current() && this.player.playing());

  protected play(): void {
    if (this.current()) this.player.toggle();
    else void this.player.play(this.track(), this.queue());
  }

  protected time(s: number): string {
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }
}
