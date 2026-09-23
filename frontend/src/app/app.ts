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

  protected readonly title = signal('Job Applications');
  protected readonly backendStatus = signal<'checking' | 'connected' | 'unreachable'>('checking');
  protected readonly loginPending = signal(false);
  protected readonly loginResult = signal<string | null>(null);
  protected readonly cvMatchPending = signal(false);
  protected readonly cvMatchResult = signal<string | null>(null);
  protected readonly cvMatchAnalysis = signal<string | null>(null);
  protected readonly cvMatchJobUrl = signal<string | null>(null);
  protected readonly cvMatchTotalJobs = signal<number | null>(null);
  protected readonly jobIndex = signal(1);
  protected readonly useBasicSearch = signal(false);

  private lastLoginSuccess: boolean | null = null;
  private lastCvMatchSuccess: boolean | null = null;

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
        this.lastLoginSuccess = response.success;
        this.updateBackendStatusFromActions();
        this.loginPending.set(false);
      },
      error: () => {
        this.loginResult.set('Login failed !');
        this.lastLoginSuccess = false;
        this.updateBackendStatusFromActions();
        this.loginPending.set(false);
      }
    });
  }

  protected onJobIndexInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.jobIndex.set(Number.isFinite(value) ? value : 0);
  }

  protected onUseBasicSearchChange(event: Event): void {
    this.useBasicSearch.set((event.target as HTMLInputElement).checked);
  }

  protected onCvMatchClick(): void {
    this.cvMatchPending.set(true);
    this.cvMatchResult.set(null);
    this.cvMatchAnalysis.set(null);
    this.cvMatchJobUrl.set(null);
    this.cvMatchTotalJobs.set(null);
    this.api.cvMatch(this.jobIndex(), this.useBasicSearch()).subscribe({
      next: (response) => {
        this.cvMatchResult.set(response.success ? 'Analysis succeeded !' : 'Analysis failed !');
        this.cvMatchAnalysis.set(response.success ? response.analysis : null);
        this.cvMatchJobUrl.set(response.success ? response.jobUrl : null);
        // Shown regardless of success — knowing the total match count is still useful context
        // even when the requested job index came back out of range for it.
        this.cvMatchTotalJobs.set(response.totalJobsCount);
        this.lastCvMatchSuccess = response.success;
        this.updateBackendStatusFromActions();
        this.cvMatchPending.set(false);
      },
      error: () => {
        this.cvMatchResult.set('Analysis failed !');
        this.cvMatchAnalysis.set(null);
        this.cvMatchJobUrl.set(null);
        this.cvMatchTotalJobs.set(null);
        this.lastCvMatchSuccess = false;
        this.updateBackendStatusFromActions();
        this.cvMatchPending.set(false);
      }
    });
  }

  // A single failed action doesn't necessarily mean the backend is unreachable (e.g. jobup.ch
  // itself rejected the login), so only flip to 'unreachable' once both actions have been tried
  // and both failed; either one succeeding is enough to consider the backend 'connected'.
  private updateBackendStatusFromActions(): void {
    if (this.lastLoginSuccess === true || this.lastCvMatchSuccess === true) {
      this.backendStatus.set('connected');
    } else if (this.lastLoginSuccess === false && this.lastCvMatchSuccess === false) {
      this.backendStatus.set('unreachable');
    }
  }
}
