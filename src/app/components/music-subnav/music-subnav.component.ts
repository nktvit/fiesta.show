import { Component } from '@angular/core';
import { IsActiveMatchOptions, RouterLink, RouterLinkActive } from '@angular/router';

// Query strings (?q=, ?tab=, ?musicdebug=) never change which section is active.
const EXACT: IsActiveMatchOptions = { paths: 'exact', queryParams: 'ignored', matrixParams: 'ignored', fragment: 'ignored' };
const PREFIX: IsActiveMatchOptions = { paths: 'subset', queryParams: 'ignored', matrixParams: 'ignored', fragment: 'ignored' };

/** Sections inside /music: Home, Explore, Library, Recent, Settings. Sits under the navbar on every music page. */
@Component({
  selector: 'app-music-subnav',
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './music-subnav.component.html',
  host: { class: 'block' },
})
export class MusicSubnavComponent {
  protected readonly links = [
    { label: 'Home', path: '/music', match: EXACT },
    { label: 'Explore', path: '/music/explore', match: PREFIX },
    { label: 'Library', path: '/music/library', match: PREFIX },
    { label: 'Recent', path: '/music/recent', match: PREFIX },
    { label: 'Settings', path: '/music/settings', match: PREFIX },
  ];
}
