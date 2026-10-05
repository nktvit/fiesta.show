import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicUiService } from '../../services/music-ui.service';
import { time } from '../../utils/music-format';
import { MusicDialogComponent } from '../music-dialog/music-dialog.component';

const QUALITY: Record<string, string> = {
  LOW: 'AAC 96 kbps', HIGH: 'AAC 320 kbps', LOSSLESS: 'Lossless (CD quality)', HI_RES_LOSSLESS: 'Hi-Res Lossless',
};

interface InfoRow {
  label: string;
  value: string;
  /** Fiesta route when the value is a link. */
  link?: string[];
}

/** Track info dialog. Visible when ui.trackInfo() !== null. Lists every field we know about the track. */
@Component({
  selector: 'app-music-track-info',
  imports: [MusicDialogComponent, RouterLink],
  templateUrl: './music-track-info.component.html',
})
export class MusicTrackInfoComponent {
  protected readonly ui = inject(MusicUiService);
  private player = inject(MusicPlayerService);

  protected readonly rows = computed<InfoRow[]>(() => {
    const t = this.ui.trackInfo();
    if (!t) return [];
    const rows: InfoRow[] = [{ label: 'Title', value: t.version ? `${t.title} (${t.version})` : t.title }];
    const artists = t.artists?.length ? t.artists : t.artistId !== null ? [{ id: t.artistId, name: t.artist }] : [];
    if (artists.length > 1) rows.push({ label: 'Artists', value: artists.map((a) => a.name).join(', ') });
    rows.push({ label: 'Artist', value: t.artist, link: t.artistId !== null ? ['/music/artist', String(t.artistId)] : undefined });
    rows.push({ label: 'Album', value: t.album, link: t.albumId !== null ? ['/music/album', String(t.albumId)] : undefined });
    rows.push({ label: 'Duration', value: time(t.duration) });
    if (t.trackNumber) rows.push({ label: 'Track number', value: String(t.trackNumber) });
    if (t.releaseDate) rows.push({ label: 'Released', value: t.releaseDate.slice(0, 10) });
    rows.push({ label: 'Explicit', value: t.explicit ? 'Yes' : 'No' });
    const playing = this.player.track()?.id === t.id ? this.player.quality() : '';
    rows.push({ label: 'Quality', value: QUALITY[playing || t.quality] ?? (playing || t.quality || 'Unknown') });
    if (t.isrc) rows.push({ label: 'ISRC', value: t.isrc });
    if (t.bpm) rows.push({ label: 'BPM', value: String(Math.round(t.bpm)) });
    if (t.popularity !== undefined) rows.push({ label: 'Popularity', value: String(Math.round(t.popularity)) });
    if (t.replayGain !== undefined) rows.push({ label: 'ReplayGain', value: `${t.replayGain.toFixed(2)} dB` });
    if (t.peak !== undefined) rows.push({ label: 'Peak amplitude', value: t.peak.toFixed(3) });
    if (t.copyright) rows.push({ label: 'Copyright', value: t.copyright });
    rows.push({ label: 'Track ID', value: String(t.id) });
    if (t.artistId !== null) rows.push({ label: 'Artist ID', value: String(t.artistId) });
    if (t.albumId !== null) rows.push({ label: 'Album ID', value: String(t.albumId) });
    return rows;
  });

  protected openLink(): void {
    // Following a link leaves the page: the overlay closes with it (settings.closeOverlaysOnNavigate), but not
    // when that setting is off, so close explicitly.
    this.ui.closeTrackInfo();
  }
}
