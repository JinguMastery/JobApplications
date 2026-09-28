import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface HealthResponse {
  status: string;
  service: string;
  timestamp: string;
}

export interface LoginResponse {
  success: boolean;
  message: string;
}

export interface AnalysisMeter {
  color: 'green' | 'yellow' | null;
  percent: number | null;
}

export interface AnalysisCriterion {
  text: string;
  status: 'green' | 'yellow' | 'gray';
}

export interface StopCvMatchResponse {
  stopped: boolean;
}

export interface CvMatchResponse {
  success: boolean;
  analysis: string | null;
  meter: AnalysisMeter | null;
  criteria: AnalysisCriterion[];
  jobUrl: string | null;
  totalJobsCount: number | null;
  errorMessage: string | null;
  resultsUrl: string | null;
  applicationUrl: string | null;
}

@Injectable({ providedIn: 'root' })
export class Api {
  constructor(private readonly http: HttpClient) {}

  getHealth(): Observable<HealthResponse> {
    return this.http.get<HealthResponse>('/api/health');
  }

  login(credentials: { email: string; password: string }): Observable<LoginResponse> {
    return this.http.post<LoginResponse>('/api/login', credentials);
  }

  cvMatch(options: {
    jobIndex: number;
    useBasicSearch: boolean;
    searchTerm: string;
    locations: string[];
    saveJob: boolean;
    easyApply: boolean;
    ignoreYellowMeter: boolean;
  }): Observable<CvMatchResponse> {
    return this.http.post<CvMatchResponse>('/api/cv-match', options);
  }

  stopCvMatch(): Observable<StopCvMatchResponse> {
    return this.http.post<StopCvMatchResponse>('/api/cv-match/stop', {});
  }
}
