import {Routes} from '@angular/router'

export const routes: Routes = [
  {path: "", loadComponent: () => import('./pages/main/main.component').then(m => m.MainComponent), data: {mode: 'home'}},
  {path: 'search', loadComponent: () => import('./pages/search-page/search-page.component').then(m => m.SearchPageComponent), data: {mode: 'search'}},
  {path: 'about', loadComponent: () => import('./pages/about/about.component').then(m => m.AboutComponent)},
  {path: 'terms', loadComponent: () => import('./pages/terms/terms.component').then(m => m.TermsComponent)},
  {path: "movie/:id", loadComponent: () => import('./pages/movie-page/movie-page.component').then(m => m.MoviePageComponent)},
  {path: "person/:id", loadComponent: () => import('./pages/person-page/person-page.component').then(m => m.PersonPageComponent)},
  {path: 'genre/:id', loadComponent: () => import('./pages/genre/genre.component').then(m => m.GenreComponent)},
  {path: 'top-rated', loadComponent: () => import('./pages/top-rated/top-rated.component').then(m => m.TopRatedComponent)},
  {path: 'tv', loadComponent: () => import('./pages/tv/tv.component').then(m => m.TvComponent)},
  {path: 'music', loadComponent: () => import('./pages/music/music.component').then(m => m.MusicComponent)},
  {path: 'music/album/:id', loadComponent: () => import('./pages/music-album/music-album.component').then(m => m.MusicAlbumComponent)},
  {path: 'music/artist/:id', loadComponent: () => import('./pages/music-artist/music-artist.component').then(m => m.MusicArtistComponent)},
  {path: 'music/explore', loadComponent: () => import('./pages/music-explore/music-explore.component').then(m => m.MusicExploreComponent)},
  {path: 'music/library', loadComponent: () => import('./pages/music-library/music-library.component').then(m => m.MusicLibraryComponent)},
  {path: 'music/library/playlist/:id', loadComponent: () => import('./pages/music-user-playlist/music-user-playlist.component').then(m => m.MusicUserPlaylistComponent)},
  {path: 'music/recent', loadComponent: () => import('./pages/music-recent/music-recent.component').then(m => m.MusicRecentComponent)},
  {path: 'music/settings', loadComponent: () => import('./pages/music-settings/music-settings.component').then(m => m.MusicSettingsComponent)},
  {path: 'music/shared', loadComponent: () => import('./pages/music-shared-playlist/music-shared-playlist.component').then(m => m.MusicSharedPlaylistComponent)},
  {path: 'music/track/:id', loadComponent: () => import('./pages/music-track/music-track.component').then(m => m.MusicTrackComponent)},
  {path: 'music/mix/:id', loadComponent: () => import('./pages/music-mix/music-mix.component').then(m => m.MusicMixComponent)},
  {path: 'music/playlist/:id', loadComponent: () => import('./pages/music-playlist/music-playlist.component').then(m => m.MusicPlaylistComponent)},

  {path: '**', redirectTo: '', pathMatch: 'full'},
]
