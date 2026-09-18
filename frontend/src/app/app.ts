import { afterNextRender, Component, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { Api } from './services/api';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  private readonly api = inject(Api);

  protected readonly title = signal('frontend');
  protected readonly backendStatus = signal<'checking' | 'connected' | 'unreachable'>('checking');
  protected readonly loginPending = signal(false);
  protected readonly loginResult = signal<string | null>(null);

  constructor() {
    // Deferred to the browser only: at build time `ng build` prerenders this route with no
    // backend running, so an HTTP call made directly in the constructor breaks the build.
    afterNextRender(() => {
      this.api.getHealth().subscribe({
        next: () => this.backendStatus.set('connected'),
        error: () => this.backendStatus.set('unreachable')
      });
    });
  }

  protected onLoginClick(): void {
    this.loginPending.set(true);
    this.loginResult.set(null);
    this.api.login().subscribe({
      next: (response) => {
        this.loginResult.set(response.message);
        this.loginPending.set(false);
      },
      error: () => {
        this.loginResult.set('Login failed !');
        this.loginPending.set(false);
      }
    });
  }
}
