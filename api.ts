import { browser } from '$app/environment'; // Detects if running on the client
import { goto } from '$app/navigation';
import { redirect } from '@sveltejs/kit';

export async function apiFetch(endpoint: string, options: any = {}) {
  const response = await fetch(endpoint, options);

  // 🔹 If API returns 401, handle it differently for client & server
  if (response.status === 401) {
    console.warn(`API returned 401. Redirecting to login... ${endpoint}`);

    if (browser) {
      // 🔹 Client-side: Use goto()
      goto('/login');
    } else {
      // 🔹 Server-side: Use throw redirect()
      throw redirect(303, '/login');
    }

    throw new Error('Unauthorized'); // Stop execution
  }

  return response;
}
