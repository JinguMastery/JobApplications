import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface HealthResponse {
  status: string;
  service: string;
  timestamp: string;
}

export interface LoginResponse {
  message: string;
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
}
