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

export interface CvMatchResponse {
  success: boolean;
  analysis: string | null;
  jobUrl: string | null;
  totalJobsCount: number | null;
}

@Injectable({ providedIn: 'root' })
export class Api {
  constructor(private readonly http: HttpClient) {}

  getHealth(): Observable<HealthResponse> {
    return this.http.get<HealthResponse>('/api/health');
  }

  login(): Observable<LoginResponse> {
    return this.http.post<LoginResponse>('/api/login', {});
  }

  cvMatch(jobIndex: number, useBasicSearch: boolean): Observable<CvMatchResponse> {
    return this.http.post<CvMatchResponse>('/api/cv-match', { jobIndex, useBasicSearch });
  }
}
