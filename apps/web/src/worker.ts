export default { fetch(request: Request) { const url = new URL(request.url); url.hostname = 'customer.tumaffe.online'; return Response.redirect(url.toString(), 302); } };
