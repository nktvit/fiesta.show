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

  {path: '**', redirectTo: '', pathMatch: 'full'},
]
