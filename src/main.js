const paypal = require('@paypal/checkout-server-sdk');

function createPayPalClient(context) {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_SECRET;
  
  if (!clientId || !clientSecret) {
    throw new Error('PayPal credentials not configured');
  }

  const environment = process.env.PAYPAL_ENVIRONMENT === 'production'
    ? new paypal.core.LiveEnvironment(clientId, clientSecret)
    : new paypal.core.SandboxEnvironment(clientId, clientSecret);
    
  return new paypal.core.PayPalHttpClient(environment);
}

module.exports = async function(context) {
  try {
    // Validate request
    if (!context.req.body) {
      return context.res.json({
        status: 'error',
        code: 400,
        message: 'Request body is required'
      });
    }

    // Parse payload
    let payload;
    try {
      payload = typeof context.req.body === 'string' 
        ? JSON.parse(context.req.body)
        : context.req.body;
    } catch (e) {
      return context.res.json({
        status: 'error',
        code: 400,
        message: 'Invalid JSON format'
      });
    }

    // Validate payload
    if (!payload.action || !payload.data) {
      return context.res.json({
        status: 'error',
        code: 400,
        message: 'Missing action or data parameter'
      });
    }

    const paypalClient = createPayPalClient(context);

    switch (payload.action) {
      case 'createOrder': {
        // Validate amount
        const amount = parseFloat(payload.data.amount);
        if (isNaN(amount) || amount <= 0) {
          return context.res.json({
            status: 'error',
            code: 400,
            message: 'Invalid amount specified'
          });
        }

        const createRequest = new paypal.orders.OrdersCreateRequest();
        createRequest.prefer("return=representation");
        createRequest.requestBody({
          intent: 'CAPTURE',
          application_context: {
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: 'digitalevdoctor://payment-success',  
            cancel_url: 'digitalevdoctor://payment-canceled',
          },
          purchase_units: [{
            amount: {
              currency_code: payload.data.currency || 'EUR',
              value: amount.toFixed(2)
            }
          }]
        });

        const createResponse = await paypalClient.execute(createRequest);
        const approvalLink = createResponse.result.links.find(
          link => link.rel === 'approve'
        );

        if (!approvalLink?.href) {
          throw new Error('Missing approval URL in PayPal response');
        }

        return context.res.json({
          status: 'success',
          data: {
            orderId: createResponse.result.id,
            approvalUrl: approvalLink.href,
            status: createResponse.result.status
          }
        });
      }

      case 'captureOrder': {
        if (!payload.data.orderId || !/^[A-Z0-9]{17}$/.test(payload.data.orderId)) {
          return context.res.json({
            status: 'error',
            code: 400,
            message: 'Invalid order ID'
          });
        }

        const captureRequest = new paypal.orders.OrdersCaptureRequest(payload.data.orderId);
        captureRequest.requestBody({});

        const captureResponse = await paypalClient.execute(captureRequest);
        
        if (!captureResponse?.result?.id) {
          throw new Error('Incomplete capture response from PayPal');
        }

        return context.res.json({
          status: 'success',
          data: {
            captureId: captureResponse.result.id,
            status: captureResponse.result.status,
            details: {
              payer: captureResponse.result.payer,
              create_time: captureResponse.result.create_time,
              purchase_units: captureResponse.result.purchase_units
            }
          }
        });
      }

      default:
        return context.res.json({
          status: 'error',
          code: 400,
          message: 'Unsupported action'
        });
    }
  } catch (error) {
    context.error('Server Error:', error);
    
    return context.res.json({
      status: 'error',
      code: error.statusCode || 500,
      message: error.message || 'Internal server error',
      ...(process.env.NODE_ENV !== 'production' && { debug: error.stack })
    });
  }
};