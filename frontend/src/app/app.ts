import { afterNextRender, Component, HostListener, computed, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Subscription } from 'rxjs';

import { Api, AnalysisCriterion, AnalysisMeter } from './services/api';

type AnalysisListItem = { text: string; status: 'green' | 'yellow' | 'gray' | null };

type AnalysisSegment =
  | { type: 'heading'; text: string; level: 'title' | 'section' }
  | { type: 'meter'; color: 'green' | 'yellow' | null; percent: number | null }
  | { type: 'list'; items: AnalysisListItem[] }
  | { type: 'paragraph'; text: string };

const BULLET_PATTERN = /^[-•*]\s+(.*)$/;
const NUMBERED_PATTERN = /^\d+[.)]\s+(.*)$/;
const COLON_HEADING_PATTERN = /^.{1,70}:$/;
const SHORT_QUESTION_PATTERN = /^.{1,45}\?$/;

// jobup.ch's own CV-match modal always groups criteria under these two fixed section labels
// (see the "Un bon départ" screenshots), regardless of what the AI-generated verdict/criteria
// text says — so they're recognized by name rather than guessed at structurally.
const KNOWN_SECTION_HEADINGS = new Set([
  'connaissances, qualifications et compétences importantes',
  'autres demandes'
]);

function isSectionHeading(line: string): boolean {
  return (
    KNOWN_SECTION_HEADINGS.has(line.toLowerCase()) ||
    COLON_HEADING_PATTERN.test(line) ||
    SHORT_QUESTION_PATTERN.test(line)
  );
}

// Past this point the modal is just jobup.ch's own boilerplate footer (which CV was used, the
// "Analysez un autre CV" link, the usefulness survey, the AI disclaimer, "Fermer") rather than
// analysis content — none of it should be styled as a heading or list item, so parsing stops the
// moment either fixed lead-in is seen.
const STOP_MARKERS = [
  "l'évaluation est basée sur le cv suivant",
  'avez-vous trouvé cela utile'
];

function isStopMarker(line: string): boolean {
  const normalized = line.toLowerCase();
  return STOP_MARKERS.some((marker) => normalized.startsWith(marker));
}

// scripts/jobup-cv-match.js reads each criterion's real status (green/yellow/gray) straight from
// its icon's color class, separately from the plain-text analysis blob below — so a checklist
// line here is matched back to its criterion by text containment rather than trusting line order
// (a criterion with an explanation reads as two separate lines below — title, then explanation —
// while extractAnalysisStructure() captured them together as that criterion's one text block).
function findCriterionStatus(
  line: string,
  criteria: readonly AnalysisCriterion[]
): 'green' | 'yellow' | 'gray' | null {
  const normalized = line.trim();
  if (!normalized) {
    return null;
  }
  for (const criterion of criteria) {
    const text = criterion.text.trim();
    if (text === normalized || text.includes(normalized) || normalized.includes(text)) {
      return criterion.status;
    }
  }
  return null;
}

// The AI CV-match analysis comes back from the backend as one plain-text blob (see
// scripts/jobup-cv-match.js's readAnalysisAndClose(), which reads the whole modal's innerText) —
// this recovers its structure: the first line is jobup's bold verdict title ("Un bon départ"); a
// known section label (or a short ":"/"?"-terminated line) starts a new heading; every other line
// found after a heading is one checklist row, rendered as a list item (colored via `criteria`, see
// findCriterionStatus() above); lines before the first heading (the verdict's intro sentence) stay
// as their own paragraph. The overall-match meter (`meter`, read from the fill bar's own color/
// width, not text) is inserted once, right before the first section heading.
function parseAnalysis(
  raw: string,
  criteria: readonly AnalysisCriterion[],
  meter: AnalysisMeter | null
): AnalysisSegment[] {
  const segments: AnalysisSegment[] = [];
  let listItems: AnalysisListItem[] | null = null;
  let sawTitle = false;
  let inSection = false;
  let meterInserted = false;

  const flushList = () => {
    if (listItems && listItems.length > 0) {
      segments.push({ type: 'list', items: listItems });
    }
    listItems = null;
  };
  const pushListItem = (text: string) => {
    listItems ??= [];
    listItems.push({ text, status: findCriterionStatus(text, criteria) });
  };

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (isStopMarker(line)) {
      break;
    }

    const bulletMatch = line.match(BULLET_PATTERN) ?? line.match(NUMBERED_PATTERN);
    if (bulletMatch) {
      pushListItem(bulletMatch[1]);
      continue;
    }

    if (!sawTitle) {
      segments.push({ type: 'heading', text: line, level: 'title' });
      sawTitle = true;
      continue;
    }

    if (isSectionHeading(line)) {
      flushList();
      if (meter && !meterInserted) {
        segments.push({ type: 'meter', color: meter.color, percent: meter.percent });
        meterInserted = true;
      }
      segments.push({ type: 'heading', text: line, level: 'section' });
      inSection = true;
      continue;
    }

    if (inSection) {
      pushListItem(line);
      continue;
    }

    segments.push({ type: 'paragraph', text: line });
  }
  flushList();

  return segments;
}

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
  protected readonly jobupEmail = signal('');
  protected readonly jobupPassword = signal('');
  protected readonly cvMatchPending = signal(false);
  protected readonly cvMatchResult = signal<string | null>(null);
  protected readonly cvMatchAnalysis = signal<string | null>(null);
  protected readonly cvMatchMeter = signal<AnalysisMeter | null>(null);
  protected readonly cvMatchCriteria = signal<AnalysisCriterion[]>([]);
  protected readonly cvMatchJobUrl = signal<string | null>(null);
  protected readonly cvMatchTotalJobs = signal<number | null>(null);
  protected readonly cvMatchResultsUrl = signal<string | null>(null);
  protected readonly cvMatchApplicationUrl = signal<string | null>(null);
  protected readonly jobIndex = signal(1);
  protected readonly searchTerm = signal('');
  protected readonly locationInput = signal('');
  protected readonly useBasicSearch = signal(false);
  protected readonly saveJob = signal(false);
  protected readonly easyApply = signal(false);
  protected readonly ignoreYellowMeter = signal(false);
  protected readonly jobFiltersExpanded = signal(false);
  protected readonly analysisExpanded = signal(true);
  protected readonly cvMatchAnalysisSegments = computed(() => {
    const analysis = this.cvMatchAnalysis();
    return analysis ? parseAnalysis(analysis, this.cvMatchCriteria(), this.cvMatchMeter()) : [];
  });

  // Tracked so onStopClick() can unsubscribe from the in-flight cvMatch() request — the backend
  // POST /api/cv-match call stays open for the whole analysis (it awaits the child process), so
  // stopping it server-side still leaves this subscription's next/error callback to fire once that
  // now-killed process's response eventually arrives. Unsubscribing cancels the underlying
  // HttpClient request (this app uses provideHttpClient(withFetch()), which cancels the fetch on
  // unsubscribe) so that stale response can never overwrite the state reset below it.
  private cvMatchSubscription: Subscription | null = null;

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

  protected onJobupEmailInput(event: Event): void {
    this.jobupEmail.set((event.target as HTMLInputElement).value);
  }

  protected onJobupPasswordInput(event: Event): void {
    this.jobupPassword.set((event.target as HTMLInputElement).value);
  }

  // Bound to the login <form>'s native (submit) event (see app.html) rather than (ngSubmit) — this
  // app doesn't use Angular's FormsModule anywhere else, so a plain 'submit' listener is used
  // instead, with preventDefault() here to stop an actual page reload/navigation. The form's
  // type="email"/required attributes are native HTML5 "built-in validators": the browser blocks the
  // 'submit' event entirely (and shows its own validation UI) whenever a field is empty or not a
  // well-formed email, so this never even runs in that case — no custom validation logic needed.
  protected onLoginSubmit(event: Event): void {
    event.preventDefault();
    this.onLoginClick();
  }

  protected onLoginClick(): void {
    this.loginPending.set(true);
    this.loginResult.set(null);
    this.api.login({ email: this.jobupEmail(), password: this.jobupPassword() }).subscribe({
      next: (response) => {
        this.loginResult.set(response.message);
        // Receiving any well-formed HTTP response at all — success, a specific known failure
        // reason, or even the generic "Login failed !" (which can mean the backend hit a
        // genuinely unexpected internal error, not that it's unreachable) — proves the backend
        // itself is up and reachable; only a real network-level failure (the error callback
        // below) means otherwise. See the same reasoning on onCvMatchClick()'s next callback.
        this.backendStatus.set('connected');
        this.loginPending.set(false);
      },
      error: () => {
        this.loginResult.set('Login failed !');
        this.backendStatus.set('unreachable');
        this.loginPending.set(false);
      }
    });
  }

  protected onJobIndexInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.jobIndex.set(Number.isFinite(value) ? value : 0);
  }

  protected onSearchTermInput(event: Event): void {
    this.searchTerm.set((event.target as HTMLInputElement).value);
  }

  protected onLocationInput(event: Event): void {
    this.locationInput.set((event.target as HTMLInputElement).value);
  }

  protected onUseBasicSearchChange(event: Event): void {
    this.useBasicSearch.set((event.target as HTMLInputElement).checked);
  }

  protected onSaveJobChange(event: Event): void {
    this.saveJob.set((event.target as HTMLInputElement).checked);
    this.resetIgnoreYellowMeterIfMoot();
  }

  protected onEasyApplyChange(event: Event): void {
    this.easyApply.set((event.target as HTMLInputElement).checked);
    this.resetIgnoreYellowMeterIfMoot();
  }

  // "Ignore jobs with a yellow meter" has no effect once both actions it would gate are unchecked
  // (see its [disabled] binding in app.html) — uncheck it too at that point, rather than leaving a
  // checked-but-disabled, now-meaningless checkbox behind.
  private resetIgnoreYellowMeterIfMoot(): void {
    if (!this.saveJob() && !this.easyApply()) {
      this.ignoreYellowMeter.set(false);
    }
  }

  protected onIgnoreYellowMeterChange(event: Event): void {
    this.ignoreYellowMeter.set((event.target as HTMLInputElement).checked);
  }

  protected onToggleJobFilters(): void {
    this.jobFiltersExpanded.update((expanded) => !expanded);
  }

  // Closes the "Job filters" dropdown on any click outside it — deliberately independent of
  // cvMatchPending()/the toggle button's [disabled] state, so a panel left open when a run starts
  // can still be dismissed by clicking away, even though the button itself won't respond to clicks
  // while disabled.
  @HostListener('document:click', ['$event'])
  protected onDocumentClick(event: MouseEvent): void {
    if (!this.jobFiltersExpanded()) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target && !target.closest('.job-filters-dropdown')) {
      this.jobFiltersExpanded.set(false);
    }
  }

  protected onToggleAnalysis(): void {
    this.analysisExpanded.update((expanded) => !expanded);
  }

  // Shared by onCvMatchClick() (starting a run, pending: true) and onStopClick() (abandoning one,
  // pending: false) — both put the CV-match section back to the same "nothing to show yet" shape,
  // just with a different pending state.
  private resetCvMatchState(pending: boolean): void {
    this.cvMatchPending.set(pending);
    this.cvMatchResult.set(null);
    this.cvMatchAnalysis.set(null);
    this.cvMatchMeter.set(null);
    this.cvMatchCriteria.set([]);
    this.cvMatchJobUrl.set(null);
    this.cvMatchTotalJobs.set(null);
    this.cvMatchResultsUrl.set(null);
    this.cvMatchApplicationUrl.set(null);
    this.analysisExpanded.set(true);
  }

  protected onCvMatchClick(): void {
    this.resetCvMatchState(true);
    const trimmedSearchTerm = this.searchTerm().trim();
    const locations = this.locationInput()
      .split(',')
      .map((location) => location.trim())
      .filter((location) => location.length > 0);
    this.cvMatchSubscription = this.api
      .cvMatch({
        jobIndex: this.jobIndex(),
        useBasicSearch: this.useBasicSearch(),
        searchTerm: trimmedSearchTerm,
        locations,
        saveJob: this.saveJob(),
        easyApply: this.easyApply(),
        ignoreYellowMeter: this.ignoreYellowMeter()
      })
      .subscribe({
        next: (response) => {
          this.cvMatchSubscription = null;
          // A non-null errorMessage is a specific, expected failure (e.g. jobup.ch reporting 0
          // matching jobs for the given search term/locations) meant to be shown as-is instead of
          // the generic fallback.
          const resultMessage = response.success
            ? 'Analysis succeeded !'
            : (response.errorMessage ?? 'Analysis failed !');
          this.cvMatchResult.set(resultMessage);
          this.cvMatchAnalysis.set(response.success ? response.analysis : null);
          this.cvMatchMeter.set(response.success ? response.meter : null);
          this.cvMatchCriteria.set(response.success ? response.criteria : []);
          this.cvMatchJobUrl.set(response.success ? response.jobUrl : null);
          // Shown regardless of success — knowing the total match count (and the results page it
          // came from) is still useful context even when the requested job index came back out of
          // range, or the search itself found nothing.
          this.cvMatchTotalJobs.set(response.totalJobsCount);
          this.cvMatchResultsUrl.set(response.resultsUrl);
          // Only ever non-null when a draft application page was actually opened (easyApply on, a
          // meter present, "Candidature simplifiée"/"Continuer ma candidature" available), which
          // only happens alongside a successful analysis — gated on response.success the same way
          // as cvMatchJobUrl, for the same reason.
          this.cvMatchApplicationUrl.set(response.success ? response.applicationUrl : null);
          // Receiving any well-formed HTTP response at all proves the backend itself is up and
          // reachable — see onLoginClick()'s matching comment for the full reasoning.
          this.backendStatus.set('connected');
          this.cvMatchPending.set(false);
        },
        error: () => {
          this.cvMatchSubscription = null;
          this.cvMatchResult.set('Analysis failed !');
          this.cvMatchAnalysis.set(null);
          this.cvMatchMeter.set(null);
          this.cvMatchCriteria.set([]);
          this.cvMatchJobUrl.set(null);
          this.cvMatchTotalJobs.set(null);
          this.cvMatchResultsUrl.set(null);
          this.cvMatchApplicationUrl.set(null);
          this.backendStatus.set('unreachable');
          this.cvMatchPending.set(false);
        }
      });
  }

  // "Stop analysis": cancels this component's own wait for the in-flight POST /api/cv-match (via
  // unsubscribe — see cvMatchSubscription's comment) so its eventual response can't overwrite the
  // reset below, tells the backend to actually kill the still-running child process/browser (fire-
  // and-forget — the UI doesn't wait on this, it's already reset by the time it resolves), and puts
  // the CV-match section back exactly as it was before the run started.
  protected onStopClick(): void {
    if (!this.cvMatchPending()) {
      return;
    }
    this.cvMatchSubscription?.unsubscribe();
    this.cvMatchSubscription = null;
    this.api.stopCvMatch().subscribe({ next: () => {}, error: () => {} });
    this.resetCvMatchState(false);
  }

}
