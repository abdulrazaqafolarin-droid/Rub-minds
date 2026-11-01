package app.rubminds.companion

import org.junit.Assert.assertEquals
import org.junit.Test

class CloudDeviceApiExceptionTest {
    @Test fun pairingErrorsKeepTheirHttpStatusAndAction() {
        val error = CloudDeviceApiException("pair/claim", 409, "Pairing code expired.")
        assertEquals("pair/claim", error.action)
        assertEquals(409, error.statusCode)
        assertEquals("Pairing code expired.", error.message)
    }
}
