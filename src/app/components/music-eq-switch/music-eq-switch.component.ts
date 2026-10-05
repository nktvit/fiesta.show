import { Component, input, model } from '@angular/core';

/** An on/off switch (role=switch). `[(checked)]`, plus a visible label slot via `label`. */
@Component({
  selector: 'app-music-eq-switch',
  templateUrl: './music-eq-switch.component.html',
  host: { class: 'inline-flex' },
})
export class MusicEqSwitchComponent {
  readonly checked = model(false);
  /** Accessible name (also shown when `showLabel`). */
  readonly label = input.required<string>();
  readonly showLabel = input(true);

  protected toggle(): void {
    this.checked.set(!this.checked());
  }
}
