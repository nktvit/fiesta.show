import { Component, computed, inject, signal } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { MusicDialogComponent } from '../../components/music-dialog/music-dialog.component';
import { MusicSubnavComponent } from '../../components/music-subnav/music-subnav.component';
import { MusicTrackRowComponent } from '../../components/music-track-row/music-track-row.component';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicTrack } from '../../services/music.service';
import { groupHistory } from '../../utils/music-library-sort';
import { relativeDate } from '../../utils/music-format';

/** Route /music/recent: listening history grouped Today / Yesterday / Earlier. */
@Component({
  selector: 'app-music-recent',
  imports: [NavbarComponent, MusicSubnavComponent, MusicTrackRowComponent, MusicDialogComponent, RouterLink],
  templateUrl: './music-recent.component.html',
})
export class MusicRecentComponent {
  protected readonly library = inject(MusicLibraryService);
  private player = inject(MusicPlayerService);
  private toast = inject(MusicToastService);

  protected readonly confirmOpen = signal(false);

  private readonly entries = computed(() => this.library.history().filter((e) => !this.library.isBlocked(e.track)));

  /** Groups with, per row, the queue "from here": this track and everything older in the list. */
  protected readonly groups = computed(() => {
    const flat = this.entries().map((e) => e.track);
    let offset = 0;
    return groupHistory(this.entries()).map((g) => {
      const rows = g.entries.map((e, i) => ({
        track: e.track,
        playedAt: e.playedAt,
        rest: flat.slice(offset + i),
      }));
      offset += g.entries.length;
      return { label: g.label, rows };
    });
  });

  protected readonly total = computed(() => this.entries().length);

  constructor() {
    inject(Title).setTitle('Recently played | Stream Fiesta');
    inject(Meta).updateTag({ name: 'description', content: 'Songs you played recently.' });
  }

  protected when(ms: number): string {
    return relativeDate(ms);
  }

  protected playAll(): void {
    const list: MusicTrack[] = this.entries().map((e) => e.track);
    if (list.length) void this.player.play(list[0], list, { context: { type: 'library', label: 'Recently played' } });
  }

  protected clear(): void {
    this.library.clearHistory();
    this.confirmOpen.set(false);
    this.toast.show({ message: 'History cleared' });
  }
}
