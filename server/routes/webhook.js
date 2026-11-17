import { Router } from 'express';

const router = Router();

router.post('/google-assistant-webhook', (request, response) => {
  const body = request.body || {};
  if (body.handler?.name || body.intent?.name) {
    return response.json(createConversationalActionsResponse(body));
  }

  const intent = body.queryResult?.intent?.displayName || body.intent;
  const fulfillmentText = intent ? `Comanda recibida para cocina: ${intent}.` : 'No se reconoció la intención de la comanda.';
  response.json({ fulfillmentText, source: 'gastropulse' });
});

function createConversationalActionsResponse(body) {
  const handlerName = body.handler?.name || body.intent?.name || 'unknown';
  const table = getParam(body.intent?.params, ['table', 'mesa']);
  const items = getParam(body.intent?.params, ['items', 'pedido', 'productos']);
  const isOrderHandler = /order|pedido|comanda/i.test(handlerName);
  const speech = isOrderHandler
    ? `Recibí tu comanda${table ? ` para la mesa ${table}` : ''}${items ? `: ${items}` : ''}. La enviaré a cocina.`
    : 'Bienvenido a GastroPulse. Puedes decirme qué deseas pedir.';

  return {
    session: {
      id: body.session?.id || `gastropulse-${Date.now()}`,
      params: { ...body.session?.params, ...(table ? { table } : {}), ...(items ? { items } : {}) }
    },
    prompt: {
      override: false,
      firstSimple: { speech, text: speech }
    }
  };
}

function getParam(params = {}, names) {
  for (const name of names) {
    const value = params[name];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'object') return value.resolved ?? value.original ?? value.value;
    return value;
  }
  return null;
}

export default router;
